import { createSign } from "node:crypto"
import { ConnectError, getTokenResponse } from "@vercel/connect"
import { DEFAULT_AGENT_GITHUB_ACCESS, type AgentGithubAccess } from "@/lib/agent-github-access-level"

/**
 * GitHub App installation tokens come from one of two sources. On Vercel, a
 * Vercel Connect connector (COMPASS_GITHUB_CONNECTOR) holds the App's private key.
 * Off Vercel, Compass signs with the key itself (COMPASS_GITHUB_APP_ID and
 * COMPASS_GITHUB_APP_PRIVATE_KEY). The connector wins when both are set. Neither
 * means the feature is off and agent turns run without push access.
 */
export const GITHUB_CONNECTOR_ENV = "COMPASS_GITHUB_CONNECTOR"
export const GITHUB_APP_ID_ENV = "COMPASS_GITHUB_APP_ID"
export const GITHUB_APP_PRIVATE_KEY_ENV = "COMPASS_GITHUB_APP_PRIVATE_KEY"

export function githubConnectorUid(): string | null {
  return process.env[GITHUB_CONNECTOR_ENV]?.trim() || null
}

function directAppCredentials(): { appId: string; privateKey: string } | null {
  const appId = process.env[GITHUB_APP_ID_ENV]?.trim()
  // Accept a key pasted with literal "\n" escapes as well as real newlines.
  const privateKey = process.env[GITHUB_APP_PRIVATE_KEY_ENV]?.replace(/\\n/g, "\n").trim()
  return appId && privateKey ? { appId, privateKey } : null
}

/** Whether this deployment can mint GitHub App tokens by either path. */
export function githubAppConfigured(): boolean {
  return Boolean(githubConnectorUid() || directAppCredentials())
}

export { DEFAULT_AGENT_GITHUB_ACCESS, isAgentGithubAccess, type AgentGithubAccess } from "@/lib/agent-github-access-level"

/** Least privilege for agent development work: branches, commits, PRs. Nothing else. */
export const AGENT_GITHUB_PERMISSIONS = ["contents:write", "pull_requests:write", "metadata:read"] as const

/** Read-only variant: clone and inspect, no pushes, no PR creation. */
export const AGENT_GITHUB_READ_PERMISSIONS = ["contents:read", "pull_requests:read", "metadata:read"] as const

/** Code-only read: no pull request access at all. */
export const AGENT_GITHUB_CODE_READ_PERMISSIONS = ["contents:read", "metadata:read"] as const

export function permissionsForAccess(access: AgentGithubAccess): readonly string[] {
  if (access === "code-read") return AGENT_GITHUB_CODE_READ_PERMISSIONS
  return access === "read" ? AGENT_GITHUB_READ_PERMISSIONS : AGENT_GITHUB_PERMISSIONS
}

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
 * Mints a short-lived app installation token, refined to the given repositories
 * (all under one owner) and AGENT_GITHUB_PERMISSIONS regardless of what the app
 * itself is granted. The token is returned to the caller and never stored or
 * logged here.
 */
export async function mintRepoInstallationToken(
  /** `permissions` overrides the access level's set (capability packs, installation probes). */
  repo: { owner: string; names: string[]; permissions?: readonly string[] },
  access: AgentGithubAccess = DEFAULT_AGENT_GITHUB_ACCESS,
): Promise<{ token: string; expiresAt: number }> {
  if (!githubAppConfigured()) throw new Error(`${GITHUB_CONNECTOR_ENV} or ${GITHUB_APP_ID_ENV} and ${GITHUB_APP_PRIVATE_KEY_ENV} must be configured`)
  if (!REPO_PART.test(repo.owner) || !repo.names.length || !repo.names.every(n => REPO_PART.test(n))) throw new Error("Invalid repository")
  return requestInstallationToken(repo.owner, repo.names, repo.permissions ?? permissionsForAccess(access))
}

async function requestInstallationToken(owner: string, names: string[], permissions: readonly string[]): Promise<{ token: string; expiresAt: number }> {
  const uid = githubConnectorUid()
  if (uid) {
    try {
      const minted = await getTokenResponse(uid, {
        subject: { type: "app" },
        authorizationDetails: [
          { type: "github_app_installation", org: owner, repositories: names, permissions: [...permissions] },
        ],
      })
      return { token: minted.token, expiresAt: minted.expiresAt }
    } catch (error) {
      // Never echo upstream bodies: surface only the Connect error code/status.
      if (error instanceof ConnectError) throw new Error(`Vercel Connect GitHub token request failed (${error.code ?? error.status ?? "error"})`)
      throw new Error("Vercel Connect GitHub token request failed")
    }
  }
  const credentials = directAppCredentials()
  if (!credentials) throw new Error("The GitHub App is not configured for this deployment")
  return mintDirectInstallationToken(credentials, owner, names, permissions)
}

const GITHUB_API = "https://api.github.com"

/** RS256 app JWT. iat is backdated a minute for clock drift; GitHub rejects exp more than 10 minutes out. */
export function signAppJwt(appId: string, privateKey: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url")
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId })}`
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url")}`
}

/** ["contents:write", "metadata:read"] -> { contents: "write", metadata: "read" } */
function permissionsObject(permissions: readonly string[]): Record<string, string> {
  return Object.fromEntries(permissions.map(p => p.split(":") as [string, string]))
}

const installationIds = new Map<string, number>()

function githubHeaders(bearer: string): Record<string, string> {
  return { Authorization: `Bearer ${bearer}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }
}

async function installationIdFor(owner: string, jwt: string): Promise<number> {
  const key = owner.toLowerCase()
  const cached = installationIds.get(key)
  if (cached) return cached
  for (const kind of ["orgs", "users"]) {
    const res = await fetch(`${GITHUB_API}/${kind}/${owner}/installation`, { headers: githubHeaders(jwt), cache: "no-store" })
    if (res.status === 404) continue
    if (!res.ok) throw new Error(`GitHub App installation lookup failed (${res.status})`)
    const id = ((await res.json()) as { id?: number }).id
    if (!id) throw new Error("GitHub App installation lookup failed")
    installationIds.set(key, id)
    return id
  }
  throw new Error(`GitHub App is not installed on ${owner}`)
}

/**
 * Signs an app JWT and exchanges it for an installation token refined to `names`
 * and `permissions`. GitHub itself enforces the refinement. Upstream bodies are
 * never echoed; errors carry only the HTTP status.
 */
async function mintDirectInstallationToken(
  credentials: { appId: string; privateKey: string },
  owner: string,
  names: string[],
  permissions: readonly string[],
): Promise<{ token: string; expiresAt: number }> {
  let jwt: string
  try {
    jwt = signAppJwt(credentials.appId, credentials.privateKey)
  } catch {
    throw new Error(`${GITHUB_APP_PRIVATE_KEY_ENV} is not a valid private key`)
  }
  const id = await installationIdFor(owner, jwt)
  const res = await fetch(`${GITHUB_API}/app/installations/${id}/access_tokens`, {
    method: "POST",
    headers: { ...githubHeaders(jwt), "Content-Type": "application/json" },
    body: JSON.stringify({ repositories: names, permissions: permissionsObject(permissions) }),
    cache: "no-store",
  })
  if (res.status === 404) installationIds.delete(owner.toLowerCase())
  if (!res.ok) throw new Error(`GitHub App token request failed (${res.status})`)
  const body = (await res.json()) as { token?: string; expires_at?: string }
  if (!body.token || !body.expires_at) throw new Error("GitHub App token request failed")
  return { token: body.token, expiresAt: Date.parse(body.expires_at) }
}

/** Test hook: forget cached installation ids. */
export function resetGithubAppInstallationCache(): void {
  installationIds.clear()
}

/**
 * Whether the GitHub App can be granted this repo at the given access level.
 * Connect's refined token request fails when the repo is outside the installation
 * AND when the App itself lacks a requested permission, and GitHub returns the same
 * error for both. So on failure, probe with metadata:read only: if that mints, the
 * install is fine and the missing piece is the permission. Never throws.
 */
export type RepoAccessCheck = "ok" | "not_installed" | "missing_permission"

export async function checkAppAccessOn(repo: { owner: string; name: string }, access: AgentGithubAccess): Promise<RepoAccessCheck> {
  const target = { owner: repo.owner, names: [repo.name] }
  try {
    await mintRepoInstallationToken(target, access)
    return "ok"
  } catch {
    try {
      await mintRepoInstallationToken({ ...target, permissions: ["metadata:read"] }, access)
      return "missing_permission"
    } catch {
      return "not_installed"
    }
  }
}

/**
 * GitHub env for an interactive agent sandbox from a workspace's approved repo
 * list, or `{}` when the list is empty or the connector isn't configured. Failure is
 * non-fatal (the turn runs without push access) and logs only the message.
 */
export async function mintAgentGithubEnv(repos: string[], access: AgentGithubAccess = DEFAULT_AGENT_GITHUB_ACCESS): Promise<Record<string, string>> {
  if (!repos.length || !githubAppConfigured()) return {}
  const parsed = parseAgentRepos(repos)
  if (!parsed.ok || !parsed.repos.length) return {}
  const owner = parsed.repos[0].split("/")[0]
  const names = parsed.repos.map(r => r.split("/")[1])
  try {
    const { token } = await mintRepoInstallationToken({ owner, names }, access)
    return { GH_TOKEN: token, GITHUB_TOKEN: token, AGENT_GITHUB_REPOS: parsed.repos.join(","), AGENT_GITHUB_ACCESS: access }
  } catch (error) {
    console.error("[agent-github] could not mint installation token", error instanceof Error ? error.message : "unknown error")
    return {}
  }
}
