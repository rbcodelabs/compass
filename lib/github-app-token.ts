import { createSign } from "node:crypto"

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** Least privilege for agent development work: branches, commits, PRs. Nothing else. */
export const AGENT_GITHUB_PERMISSIONS = { contents: "write", pull_requests: "write", metadata: "read" } as const

const FETCH_TIMEOUT_MS = 15_000
const REPO_PART = /^[A-Za-z0-9._-]+$/

const b64url = (input: string | Buffer) => Buffer.from(input).toString("base64url")

/** GitHub App JWT (RS256, 9 min). `iat` is backdated 60s to tolerate clock skew. */
export function createAppJwt(appId: string, privateKey: string, now = Math.floor(Date.now() / 1000)): string {
  const pem = privateKey.replace(/\\n/g, "\n")
  const body = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }))}`
  return `${body}.${b64url(createSign("RSA-SHA256").update(body).sign(pem))}`
}

async function githubJson(fetcher: FetchLike, url: string, init: RequestInit): Promise<{ id?: number; token?: string; expires_at?: string }> {
  const response = await fetcher(url, {
    ...init,
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...init.headers },
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: "no-store",
  })
  // Never echo the response body: it can contain request context we don't want in logs.
  if (!response.ok) throw new Error(`GitHub App request failed (${response.status})`)
  return response.json()
}

/** Repos an agent may be granted: all in ONE owner (one installation, one token), capped. */
export const MAX_AGENT_GITHUB_REPOS = 10

/** Parse and validate "owner/name" entries. Returns the cleaned list or a user-facing error. */
export function parseAgentRepos(input: string[]): { ok: true; repos: string[] } | { ok: false; error: string } {
  const repos: string[] = []
  for (const raw of input) {
    const entry = raw.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "")
    if (!entry) continue
    const parts = entry.split("/")
    if (parts.length !== 2 || !REPO_PART.test(parts[0]) || !REPO_PART.test(parts[1])) return { ok: false, error: `"${raw.trim()}" is not a valid owner/name repository` }
    const normalized = `${parts[0]}/${parts[1]}`
    if (!repos.some(r => r.toLowerCase() === normalized.toLowerCase())) repos.push(normalized)
  }
  if (repos.length > MAX_AGENT_GITHUB_REPOS) return { ok: false, error: `At most ${MAX_AGENT_GITHUB_REPOS} repositories` }
  if (new Set(repos.map(r => r.split("/")[0].toLowerCase())).size > 1) return { ok: false, error: "All repositories must belong to the same GitHub owner" }
  return { ok: true, repos }
}

/** Whether the GitHub App is installed on the repo. Never throws on a plain "no". */
export async function isAppInstalledOn(repo: { owner: string; name: string }, opts: { appId?: string; privateKey?: string; fetcher?: FetchLike } = {}): Promise<boolean> {
  const appId = opts.appId ?? process.env.GITHUB_APP_ID
  const privateKey = opts.privateKey ?? process.env.GITHUB_PRIVATE_KEY
  if (!appId || !privateKey) throw new Error("GITHUB_APP_ID and GITHUB_PRIVATE_KEY must be configured")
  if (!REPO_PART.test(repo.owner) || !REPO_PART.test(repo.name)) return false
  try {
    const installation = await githubJson(opts.fetcher ?? fetch, `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/installation`, {
      headers: { Authorization: `Bearer ${createAppJwt(appId, privateKey)}` },
    })
    return typeof installation.id === "number"
  } catch {
    return false
  }
}

/**
 * Mints a short-lived installation token limited to the given repositories (all
 * under one owner) and to AGENT_GITHUB_PERMISSIONS regardless of what the app
 * itself is granted. The token is returned to the caller and never stored or logged here.
 */
export async function mintRepoInstallationToken(
  repo: { owner: string; name: string; names?: string[] },
  opts: { appId?: string; privateKey?: string; fetcher?: FetchLike } = {},
): Promise<{ token: string; expiresAt: string }> {
  const appId = opts.appId ?? process.env.GITHUB_APP_ID
  const privateKey = opts.privateKey ?? process.env.GITHUB_PRIVATE_KEY
  if (!appId || !privateKey) throw new Error("GITHUB_APP_ID and GITHUB_PRIVATE_KEY must be configured")
  const names = repo.names?.length ? repo.names : [repo.name]
  if (!REPO_PART.test(repo.owner) || !names.every(n => REPO_PART.test(n))) throw new Error("Invalid repository")
  const fetcher = opts.fetcher ?? fetch
  const auth = { Authorization: `Bearer ${createAppJwt(appId, privateKey)}` }
  const slug = `${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`

  const installation = await githubJson(fetcher, `https://api.github.com/repos/${slug}/installation`, { headers: auth })
  if (typeof installation.id !== "number") throw new Error("GitHub App is not installed on this repository")

  const minted = await githubJson(fetcher, `https://api.github.com/app/installations/${installation.id}/access_tokens`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ repositories: names, permissions: AGENT_GITHUB_PERMISSIONS }),
  })
  if (typeof minted.token !== "string" || typeof minted.expires_at !== "string") throw new Error("GitHub returned an invalid token response")
  return { token: minted.token, expiresAt: minted.expires_at }
}

/**
 * GitHub env for an interactive agent sandbox from a workspace's approved repo
 * list, or `{}` when the list is empty or the app isn't configured. Failure is
 * non-fatal (the turn runs without push access) and logs only the message.
 */
export async function mintAgentGithubEnv(repos: string[]): Promise<Record<string, string>> {
  if (!repos.length || !process.env.GITHUB_APP_ID || !process.env.GITHUB_PRIVATE_KEY) return {}
  const parsed = parseAgentRepos(repos)
  if (!parsed.ok || !parsed.repos.length) return {}
  const owner = parsed.repos[0].split("/")[0]
  const names = parsed.repos.map(r => r.split("/")[1])
  try {
    const { token } = await mintRepoInstallationToken({ owner, name: names[0], names })
    return { GH_TOKEN: token, GITHUB_TOKEN: token, AGENT_GITHUB_REPOS: parsed.repos.join(",") }
  } catch (error) {
    console.error("[agent-github] could not mint installation token", error instanceof Error ? error.message : "unknown error")
    return {}
  }
}
