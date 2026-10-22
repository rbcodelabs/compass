import { ConnectError, getTokenResponse } from "@vercel/connect"

/**
 * GitHub App installation tokens come from Vercel Connect (connector named by
 * COMPASS_GITHUB_CONNECTOR). Connect holds the App's private key; Compass never
 * does. Unset means the feature is off and agent turns run without push access.
 */
export const GITHUB_CONNECTOR_ENV = "COMPASS_GITHUB_CONNECTOR"

export function githubConnectorUid(): string | null {
  return process.env[GITHUB_CONNECTOR_ENV]?.trim() || null
}

/** Least privilege for agent development work: branches, commits, PRs. Nothing else. */
export const AGENT_GITHUB_PERMISSIONS = ["contents:write", "pull_requests:write", "metadata:read"] as const

const REPO_PART = /^[A-Za-z0-9._-]+$/

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

/**
 * Mints a short-lived app installation token through Vercel Connect, refined to
 * the given repositories (all under one owner) and AGENT_GITHUB_PERMISSIONS
 * regardless of what the app itself is granted. Connect caches and refreshes;
 * the token is returned to the caller and never stored or logged here.
 */
export async function mintRepoInstallationToken(repo: { owner: string; names: string[] }): Promise<{ token: string; expiresAt: number }> {
  const uid = githubConnectorUid()
  if (!uid) throw new Error(`${GITHUB_CONNECTOR_ENV} must be configured`)
  if (!REPO_PART.test(repo.owner) || !repo.names.length || !repo.names.every(n => REPO_PART.test(n))) throw new Error("Invalid repository")
  try {
    const minted = await getTokenResponse(uid, {
      subject: { type: "app" },
      authorizationDetails: [
        { type: "github_app_installation", org: repo.owner, repositories: repo.names, permissions: [...AGENT_GITHUB_PERMISSIONS] },
      ],
    })
    return { token: minted.token, expiresAt: minted.expiresAt }
  } catch (error) {
    // Never echo upstream bodies: surface only the Connect error code/status.
    if (error instanceof ConnectError) throw new Error(`Vercel Connect GitHub token request failed (${error.code ?? error.status ?? "error"})`)
    throw new Error("Vercel Connect GitHub token request failed")
  }
}

/**
 * Whether the GitHub App can be granted this repo. Connect's refined token
 * request fails when the repo is outside the installation, so a successful mint
 * is the proof. Never throws on a plain "no".
 */
export async function isAppInstalledOn(repo: { owner: string; name: string }): Promise<boolean> {
  try {
    await mintRepoInstallationToken({ owner: repo.owner, names: [repo.name] })
    return true
  } catch {
    return false
  }
}

/**
 * GitHub env for an interactive agent sandbox from a workspace's approved repo
 * list, or `{}` when the list is empty or the connector isn't configured. Failure is
 * non-fatal (the turn runs without push access) and logs only the message.
 */
export async function mintAgentGithubEnv(repos: string[]): Promise<Record<string, string>> {
  if (!repos.length || !githubConnectorUid()) return {}
  const parsed = parseAgentRepos(repos)
  if (!parsed.ok || !parsed.repos.length) return {}
  const owner = parsed.repos[0].split("/")[0]
  const names = parsed.repos.map(r => r.split("/")[1])
  try {
    const { token } = await mintRepoInstallationToken({ owner, names })
    return { GH_TOKEN: token, GITHUB_TOKEN: token, AGENT_GITHUB_REPOS: parsed.repos.join(",") }
  } catch (error) {
    console.error("[agent-github] could not mint installation token", error instanceof Error ? error.message : "unknown error")
    return {}
  }
}
