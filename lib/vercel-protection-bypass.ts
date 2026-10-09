/**
 * Short-lived Vercel Deployment Protection bypass keys for screenshot capture.
 *
 * WHY THIS EXISTS — captureScreenshot used to send one static secret
 * (`MCP_BYPASS_SECRET`), valid only for Compass's own project. Artifacts routinely
 * point at OTHER prototypes on the same Vercel team, each behind its own
 * protection, so their thumbnails failed with a 401 and someone had to paste a
 * per-project secret in by hand.
 *
 * WHAT IT DOES — per capture: resolve the URL's host to a Vercel project, mint a
 * fresh automation-bypass key on that project, let the caller capture with it, then
 * revoke exactly that key. Nothing is persisted; a key lives for one capture.
 *
 * THE TEAM IS THE ALLOWLIST — a host is only eligible if the Vercel API, scoped to
 * our team, can resolve it to one of the team's projects. A third-party host 404s
 * at the lookup, so it never gets a key and never sees the header. (The static
 * host allowlist in resolveProtectionBypassSecret guards a project-wide secret;
 * this path has no such secret to leak, only a per-capture key.)
 *
 * CONFIGURATION — `VERCEL_ACCESS_TOKEN` (project read/write on the team) enables
 * this; `VERCEL_TEAM_ID` scopes requests and, when set, is also checked against the
 * resolved deployment's owner. Unset token = feature off, callers fall back to the
 * static secret.
 */

const API = "https://api.vercel.com"
const REQUEST_TIMEOUT_MS = 10_000

export class VercelBypassError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = "VercelBypassError"
  }
}

export type BypassLease = {
  projectId: string
  /** The minted secret. Hand to the capture; never log, store or return it. */
  secret: string
  /** Revoke exactly this key. Safe to call more than once. */
  revoke(): Promise<void>
}

export function isAutoBypassConfigured(): boolean {
  return Boolean(process.env.VERCEL_ACCESS_TOKEN)
}

/**
 * Mint a bypass key for the Vercel project serving `url`.
 *
 * Returns null when the host is not one of the team's projects (nothing to do, not
 * an error). Throws VercelBypassError when the API refuses — a bad token, a key
 * limit, an unexpected response — so the caller can decide to degrade.
 */
export async function leaseProtectionBypass(url: string): Promise<BypassLease | null> {
  const token = process.env.VERCEL_ACCESS_TOKEN
  if (!token) return null

  let host: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:") return null
    host = parsed.hostname.toLowerCase()
  } catch {
    return null
  }

  const projectId = await resolveProjectId(host, token)
  if (!projectId) return null

  const secret = randomSecret()
  await patchBypass(projectId, token, {
    generate: { secret, note: "compass screenshot capture (auto-minted, revoked after use)" },
  })

  let revoked = false
  return {
    projectId,
    secret,
    async revoke() {
      if (revoked) return
      // One retry: a leaked key stays valid until someone notices, so this is
      // worth a second attempt before giving up and shouting.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await patchBypass(projectId, token, { revoke: { secret, regenerate: false } })
          revoked = true
          return
        } catch (error) {
          if (attempt === 2) {
            console.error(
              `[vercel-bypass] FAILED TO REVOKE a capture bypass key on project ${projectId}. ` +
                `Remove the key noted "compass screenshot capture" in the project's Deployment Protection settings. ` +
                describe(error)
            )
          }
        }
      }
    },
  }
}

/**
 * Host -> project id, scoped to our team. Tries the deployment lookup first (covers
 * `*.vercel.app` deployment and branch URLs), then the alias lookup (covers custom
 * domains and project aliases).
 */
async function resolveProjectId(host: string, token: string): Promise<string | null> {
  const teamId = process.env.VERCEL_TEAM_ID

  const deployment = await vercelFetch(`/v13/deployments/${encodeURIComponent(host)}`, token, { method: "GET" }, { allow404: true })
  if (deployment) {
    const body = deployment as { projectId?: unknown; ownerId?: unknown }
    // Defence in depth on top of the team-scoped query.
    if (teamId && typeof body.ownerId === "string" && body.ownerId !== teamId) return null
    if (typeof body.projectId === "string" && body.projectId) return body.projectId
  }

  const alias = await vercelFetch(`/v4/aliases/${encodeURIComponent(host)}`, token, { method: "GET" }, { allow404: true })
  const projectId = (alias as { projectId?: unknown } | null)?.projectId
  return typeof projectId === "string" && projectId ? projectId : null
}

async function patchBypass(projectId: string, token: string, body: Record<string, unknown>) {
  await vercelFetch(
    `/v1/projects/${encodeURIComponent(projectId)}/protection-bypass`,
    token,
    { method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
    { allow404: false }
  )
}

async function vercelFetch(
  path: string,
  token: string,
  init: RequestInit,
  { allow404 }: { allow404: boolean }
): Promise<unknown | null> {
  const url = new URL(path, API)
  if (process.env.VERCEL_TEAM_ID) url.searchParams.set("teamId", process.env.VERCEL_TEAM_ID)

  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new VercelBypassError(`Vercel API request failed: ${describe(error)}`)
  }

  // A 403 on the lookup also means "not yours" for a project outside the token's
  // reach, but it is indistinguishable from a bad token, so it surfaces as an error.
  if (allow404 && (response.status === 404 || response.status === 410)) return null
  if (!response.ok) {
    throw new VercelBypassError(
      `Vercel API ${init.method} ${path.split("?")[0]} returned ${response.status}` +
        `${await errorDetail(response)} (teamId ${process.env.VERCEL_TEAM_ID ? "sent" : "not set"})`,
      response.status
    )
  }
  return response.json().catch(() => ({}))
}

/**
 * Vercel's own reason for a refusal (code, message, invalidToken) turns an opaque
 * 403 into something a person can act on. Only those documented error fields are
 * copied, never the body wholesale and never a request header.
 */
async function errorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: Record<string, unknown> }
    const error = body?.error
    if (!error || typeof error !== "object") return ""
    const parts: string[] = []
    if (typeof error.code === "string") parts.push(error.code)
    if (typeof error.message === "string") parts.push(error.message.slice(0, 160))
    if (error.invalidToken === true) parts.push("invalidToken")
    if (error.missingToken === true) parts.push("missingToken")
    return parts.length ? ` [${parts.join(": ")}]` : ""
  } catch {
    return ""
  }
}

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

/** 32 chars of [a-zA-Z0-9] — the shape Vercel accepts for a caller-supplied key. */
function randomSecret(): string {
  let out = ""
  while (out.length < 32) {
    const bytes = new Uint8Array(48)
    crypto.getRandomValues(bytes)
    // 256 % 62 != 0, so reject the biased tail (>= 248) rather than modulo it.
    for (const byte of bytes) {
      if (byte < 248 && out.length < 32) out += ALPHANUMERIC[byte % 62]
    }
  }
  return out
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
