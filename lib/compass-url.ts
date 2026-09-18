import { entityPath, type EntityLinkInput } from "@/lib/entity-links"

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

/**
 * The trusted deployment origin. Exported for `lib/oauth/constants.ts`, which
 * derives the OAuth `issuer` and the canonical MCP resource URI from it —
 * clients byte-compare the issuer against the URL they built, so both must come
 * from this one resolver rather than from a second, drift-prone copy.
 */
export function trustedCompassBaseUrl(): URL {
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

/**
 * The absolute, human-clickable URL for one entity: the trusted deployment
 * origin composed with the shared relative path from lib/entity-links.ts.
 *
 * Throws exactly what `trustedCompassBaseUrl` throws —
 * `CompassUrlNotConfiguredError` when the origin is simply absent, a plain
 * `Error` when a *configured* origin is unsafe. Most callers want
 * `safeEntityUrl`, which draws that distinction for them.
 */
export function entityUrl(input: EntityLinkInput): string {
  // entityPath percent-encodes every slug/id segment itself; `new URL` parses
  // that path against the origin without re-decoding it, so the escaping the
  // in-app hrefs use survives verbatim into the absolute form.
  return new URL(entityPath(input), trustedCompassBaseUrl()).toString()
}

/**
 * Runs a URL builder, degrading a *missing config* failure to `null` while
 * letting every other failure through.
 *
 * This is the whole error contract of this module in one function: an absent
 * origin is an ordinary deployment state that should cost a caller nothing
 * more than a missing link, whereas a configured-but-unsafe origin is a
 * misconfiguration that must abort the operation rather than quietly hand
 * someone a link to somewhere else (see the class doc above).
 */
export function optionalCompassUrl(build: () => string): string | null {
  try {
    return build()
  } catch (error) {
    if (error instanceof CompassUrlNotConfiguredError) return null
    throw error
  }
}

/**
 * `entityUrl` for call sites that may not have resolved the workspace's slugs
 * — an MCP handler reading them off a relation it didn't have to widen, say.
 * Missing slugs and a missing origin both yield `null`; a link is never
 * fabricated from a partial identity.
 */
export function safeEntityUrl(
  input:
    | (Omit<EntityLinkInput, "orgSlug" | "workspaceSlug"> & {
        orgSlug: string | null | undefined
        workspaceSlug: string | null | undefined
      })
    | null
    | undefined,
): string | null {
  if (!input?.orgSlug || !input.workspaceSlug) return null
  const { orgSlug, workspaceSlug } = input
  return optionalCompassUrl(() => entityUrl({ ...input, orgSlug, workspaceSlug }))
}

/**
 * Appends a `URL:` line to a tool's human-readable message when a link is
 * available. One definition shared by every MCP handler — the feedback and
 * decision modules each used to carry their own copy.
 */
export function withUrlLine(text: string, url: string | null): string {
  return url ? `${text}\nURL: ${url}` : text
}

export function feedbackItemUrl(input: {
  orgSlug: string
  workspaceSlug: string
  feedbackId: string
}): string {
  return entityUrl({
    orgSlug: input.orgSlug,
    workspaceSlug: input.workspaceSlug,
    type: "feedback",
    id: input.feedbackId,
  })
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
