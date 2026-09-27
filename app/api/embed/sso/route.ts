/**
 * Portal SSO Identify → widget visitor token, with no popup and no cookie.
 *
 * Compass already has a Portal SSO Identify feature (lib/portal-sso.ts,
 * app/api/portal/[orgSlug]/[workspaceSlug]/sso/route.ts): a customer's own
 * backend signs a short-lived HS256 JWT asserting one of *their* users'
 * identity with a per-workspace shared secret, and exchanging it mints a
 * `PortalAccount` and sets a portal session cookie. That works for the public
 * portal pages, but the embed widget cannot use it: the cookie it sets is
 * `SameSite=Lax`, and the widget's whole existence is a cross-site `fetch`
 * that cookie never accompanies. Routing the widget through the popup that
 * *does* have the cookie (app/embed/signin/) also works, but a customer whose
 * backend already mints this JWT for the portal has no reason to bounce a
 * visitor through a second window just to hand the widget the same fact
 * again.
 *
 * This route is the direct path: the widget POSTs the JWT it already has,
 * and gets a scoped `cmpvt_…` visitor token back in one round trip — the
 * same credential app/embed/signin/actions.ts mints, reached a different way.
 *
 * Reachable without a Compass session, exactly like every other route in
 * app/api/embed/ (see lib/route-access.ts's `/api/embed/` prefix). Every
 * failure below is a JSON status and never a redirect, and every response
 * goes through lib/embed/http.ts so CORS and no-store are never hand-rolled.
 *
 * Three checks gate this request, in order, same as every other embed route:
 *
 *   1. **Embed token** — `Authorization: Bearer cmpfb_…`.
 *   2. **Origin allowlist** — the request's `Origin` must be on the source's
 *      own list.
 *   3. **Rate limit** — the READ bucket for the poll-shaped part of this
 *      call, the SUBMIT bucket only once a JWT has actually verified (see
 *      below).
 *
 * ## Why PORTAL-only, and why that check runs unconditionally
 *
 * `FeedbackSource.authMode` decides which identity a source accepts.
 * INTERNAL_SSO sources are untouched by this feature on purpose — that mode
 * already has its own SSO path (Compass's own `auth()` session, checked
 * against workspace membership in app/embed/signin/actions.ts), and mixing a
 * *customer's* SSO Identify secret into that decision would let a customer's
 * backend mint an identity that maps onto a real Compass `User`, which is a
 * different security boundary than a `PortalAccount` shim entirely. So an
 * INTERNAL_SSO source is refused here regardless of what the workspace's SSO
 * Identify configuration looks like — the check runs before the
 * `ssoEnabled`/`ssoSecretEncrypted` lookup ever matters, so an INTERNAL_SSO
 * source's 403 never discloses whether the workspace happens to have SSO
 * Identify configured at all.
 *
 * ## Why SUBMIT is charged only after the JWT verifies
 *
 * The same reasoning as the INTERNAL_SSO branch of depositEmbedSignIn: a
 * customer's backend could be misconfigured, or an attacker could throw
 * garbage at this endpoint, and either one is metered on the generous 120/min
 * READ bucket rather than the 20/min SUBMIT bucket that real visitors share.
 * Charging SUBMIT for a bad token would let a broken integration (or a
 * stranger) cheaply exhaust the write quota for everyone else using this
 * source.
 */
import type { NextRequest } from "next/server"
import { decrypt } from "@/lib/crypto-secrets"
import { verifySsoToken } from "@/lib/portal-sso"
import { upsertPortalAccountFromSsoIdentity } from "@/lib/portal-auth"
import {
  EmbedSourceError,
  consumeEmbedRate,
  isOriginAllowed,
  readEmbedBearer,
  resolveEmbedToken,
  touchEmbedToken,
  type ResolvedEmbedSource,
} from "@/lib/embed-sources"
import { mintEmbedVisitorSession } from "@/lib/embed-visitor"
import { embedCorsPreflight, embedError, embedJson, readBoundedEmbedBody } from "@/lib/embed/http"

const METHODS = "POST"

export async function OPTIONS() {
  return embedCorsPreflight(METHODS)
}

/** Checks 1 and 2. Rate limiting is left to the caller, as every other embed route does. */
async function authorize(request: NextRequest): Promise<ResolvedEmbedSource> {
  const token = readEmbedBearer(request)
  if (!token) throw new EmbedSourceError(401, "Missing embed token")
  const source = await resolveEmbedToken(token)
  if (!isOriginAllowed(source.allowedOrigins, request.headers.get("origin"))) {
    throw new EmbedSourceError(403, "This origin is not allowed for this feedback source.")
  }
  return source
}

function errorResponse(error: unknown) {
  if (error instanceof EmbedSourceError) {
    return embedError(error.status, error.message, METHODS, error.status === 429 ? { "Retry-After": "60" } : undefined)
  }
  throw error
}

export async function POST(request: NextRequest) {
  try {
    const source = await authorize(request)
    // Metered before any identity work, matching every other embed route: an
    // unauthorized or malformed attempt still costs the caller a slot, so a
    // denied request is never free to retry.
    await consumeEmbedRate(source.tokenId, "READ")

    // Runs unconditionally, before the ssoEnabled lookup — see the module
    // header for why an INTERNAL_SSO source's refusal must not double as a
    // hint about the workspace's SSO Identify configuration.
    if (source.authMode !== "PORTAL") {
      return embedError(403, "SSO Identify sign-in is only available for feedback sources in PORTAL mode.", METHODS)
    }

    let payload: unknown
    try {
      payload = JSON.parse(await readBoundedEmbedBody(request))
    } catch {
      return embedError(400, "Request body must be JSON and under 32 KB.", METHODS)
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return embedError(400, "Request body must be a JSON object.", METHODS)
    }
    const rawSsoToken = (payload as Record<string, unknown>).ssoToken
    if (typeof rawSsoToken !== "string" || !rawSsoToken.trim()) {
      return embedError(400, "ssoToken is required.", METHODS)
    }

    if (!source.ssoEnabled || !source.ssoSecretEncrypted) {
      return embedError(403, "SSO Identify is not enabled for this workspace.", METHODS)
    }

    const encryptionKey = process.env.SSO_SECRET_ENCRYPTION_KEY
    if (!encryptionKey) {
      // Server misconfiguration, not a client error — fail closed either way,
      // mirroring the existing portal SSO route exactly.
      console.error("[embed-sso] SSO_SECRET_ENCRYPTION_KEY is not set")
      return embedError(500, "SSO Identify is temporarily unavailable.", METHODS)
    }

    let secret: string
    try {
      secret = decrypt(source.ssoSecretEncrypted, encryptionKey)
    } catch {
      // Ciphertext doesn't decrypt under the current key (e.g. key rotated
      // out from under stored secrets) — fail closed, never crash the route.
      console.error(`[embed-sso] Failed to decrypt SSO secret for workspace ${source.workspaceId}`)
      return embedError(500, "SSO Identify is temporarily unavailable.", METHODS)
    }

    const identity = await verifySsoToken(secret, rawSsoToken)
    if (!identity) {
      // No SUBMIT charge here — see the module header. A bad, expired, or
      // wrongly signed token is exactly the case this endpoint must not meter
      // against the 20/min write budget real visitors share.
      return embedError(
        401,
        "This sign-in cannot be completed. The token is invalid, expired, or was not signed correctly.",
        METHODS
      )
    }

    // Charged only once a token has actually verified — see the module header.
    await consumeEmbedRate(source.tokenId, "SUBMIT")

    const account = await upsertPortalAccountFromSsoIdentity(identity)
    const minted = await mintEmbedVisitorSession({
      feedbackSourceId: source.sourceId,
      identity: { portalAccountId: account.id },
    })

    void touchEmbedToken(source.tokenId)
    // Same shape the popup's postMessage payload already carries (token,
    // expiresAt, email), plus `name`, so the widget's identify() can reuse the
    // exact same "signed in" handling as the popup path rather than needing a
    // second shape to branch on.
    return embedJson(
      { token: minted.token, expiresAt: minted.expiresAt.toISOString(), email: account.email, name: account.name },
      METHODS
    )
  } catch (error) {
    return errorResponse(error)
  }
}
