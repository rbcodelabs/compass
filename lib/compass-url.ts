/**
 * Thrown when the deployment origin can't be determined because required
 * config is missing — as opposed to a configured origin being unsafe (bad
 * protocol, credentials, malformed URL). Human-facing call sites may catch
 * specifically this class to degrade to a missing link rather than failing
 * whatever operation triggered the lookup (see lib/decision-tool-handlers.ts's
 * `buildReviewUrl`). An unsafe/invalid *configured* origin is a more serious
 * failure — those throws are plain `Error` and are NOT meant to be swallowed;
 * callers should let them abort the operation.
 */
export class CompassUrlNotConfiguredError extends Error {}

function parseTrustedOrigin(raw: string, allowLocalhost: boolean): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error("Compass app URL is invalid.")
  }
  const localhost = allowLocalhost && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)
  if (url.protocol !== "https:" && !localhost) throw new Error("Compass app URL must use HTTPS (except local development).")
  if (url.username || url.password) throw new Error("Compass app URL is invalid.")
  return url
}

function parseVercelOrigin(raw: string): URL {
  const hasScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw)
  return parseTrustedOrigin(hasScheme ? raw : `https://${raw}`, false)
}

function trustedCompassBaseUrl(): URL {
  if (process.env.VERCEL_ENV === "preview") {
    const previewHost = process.env.VERCEL_BRANCH_URL ?? process.env.VERCEL_URL
    if (!previewHost) throw new CompassUrlNotConfiguredError("Compass preview URL is not configured.")
    return parseVercelOrigin(previewHost)
  }

  if (process.env.VERCEL_ENV === "production") {
    if (process.env.NEXT_PUBLIC_APP_URL) return parseTrustedOrigin(process.env.NEXT_PUBLIC_APP_URL, false)
    // Deliberately no fallback to VERCEL_PROJECT_PRODUCTION_URL: that host sits
    // behind Vercel's deployment-protection SSO wall, so silently building a
    // link on it hands a human (or a research participant, or a voice-callback
    // caller) a URL that routes into an auth wall instead of Compass's own
    // /login. A misconfigured production URL must fail loud, not degrade to a
    // host that looks like it works.
    throw new CompassUrlNotConfiguredError(
      "Compass production URL is not configured (NEXT_PUBLIC_APP_URL is missing or empty). " +
      "Refusing to fall back to the Vercel deployment host, which may sit behind deployment protection.",
    )
  }

  return parseTrustedOrigin(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000", true)
}

export function researchVoiceWorkerCallbackBaseUrl(): URL {
  const base = trustedCompassBaseUrl()
  if (process.env.VERCEL_ENV === "production" && base.port) {
    throw new Error("Compass production callback URL must use the default HTTPS port.")
  }
  return new URL("/api/internal/research/voice", base)
}

export function feedbackItemUrl(input: {
  orgSlug: string
  workspaceSlug: string
  feedbackId: string
}): string {
  const base = trustedCompassBaseUrl()
  const url = new URL(
    `/${encodeURIComponent(input.orgSlug)}/${encodeURIComponent(input.workspaceSlug)}/feedback`,
    base,
  )
  url.searchParams.set("detail", `feedback:${input.feedbackId}`)
  return url.toString()
}

export function reviewRequestUrl(input: {
  orgSlug: string
  workspaceSlug: string
  requestId: string
}): string {
  const base = trustedCompassBaseUrl()
  return new URL(
    `/${encodeURIComponent(input.orgSlug)}/${encodeURIComponent(input.workspaceSlug)}/reviews/${encodeURIComponent(input.requestId)}`,
    base,
  ).toString()
}

export function researchParticipantUrl(token: string): string {
  return new URL(`/research/${encodeURIComponent(token)}`, trustedCompassBaseUrl()).toString()
}
