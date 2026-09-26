/**
 * The widget's visitor session: check one, end one.
 *
 * Two methods, one credential, presented the same way every embed route wants
 * it: the source's embed token (`Authorization: Bearer cmpfb_…`), checked
 * against the source's origin allowlist, exactly like /api/embed/comments.
 *
 *   - **GET** presents a visitor token and reports whose it is, so a widget that
 *     found one in storage can render a signed-in state without guessing whether
 *     it still works.
 *   - **DELETE** presents a visitor token and revokes it. Sign-out.
 *
 * ## Where the third method went
 *
 * This used to also have a **POST** that exchanged a handoff nonce for a minted
 * visitor token — the only endpoint that minted one. That was the vulnerability:
 * this route is unauthenticated by design (see below), so anything reachable
 * here is reachable by a bare curl, and a nonce is chosen by whoever constructs
 * the popup URL — normally the widget, but nothing stopped an attacker from
 * picking their own, getting a target to load the popup (binding the target's
 * session to that nonce via their `SameSite=Lax` cookie), and then claiming the
 * resulting token themselves with no browser at all. The mint now happens
 * inside `depositEmbedSignIn` (app/embed/signin/actions.ts) — a same-origin,
 * cookie-authenticated server action — and the token reaches the widget over
 * `postMessage` from the popup, never through this route.
 *
 * ## Why this is unauthenticated, and why that is safe
 *
 * Nothing here reads a cookie, and no cookie would arrive: the caller is
 * JavaScript on a page Compass does not serve, PORTAL_SESSION_COOKIE is
 * `SameSite=Lax`, and these responses never set
 * `Access-Control-Allow-Credentials`. A caller's authority comes entirely from
 * what it presents in headers.
 */
import type { NextRequest } from "next/server"
import {
  EmbedSourceError,
  consumeEmbedRate,
  isOriginAllowed,
  readEmbedBearer,
  resolveEmbedToken,
  touchEmbedToken,
  type ResolvedEmbedSource,
} from "@/lib/embed-sources"
import { resolveEmbedVisitorToken, revokeEmbedVisitorToken, EMBED_VISITOR_TOKEN_PREFIX } from "@/lib/embed-visitor"
import { EMBED_VISITOR_HEADER, embedCorsPreflight, embedError, embedJson } from "@/lib/embed/http"

const METHODS = "GET, DELETE"

export async function OPTIONS() {
  return embedCorsPreflight(METHODS)
}

/**
 * Embed token + origin allowlist, the same two checks /api/embed/comments runs
 * and in the same order. Rate limiting is charged by each handler rather than
 * here, because what a handler costs differs per method.
 */
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

/**
 * Reads the visitor token from its header, tolerating a `Bearer ` prefix for the
 * same reason /api/embed/comments does: the widget carries two bearer-ish
 * credentials and shaping this one like the other is the obvious slip.
 */
function readVisitorHeader(request: NextRequest): string | null {
  const raw = request.headers.get(EMBED_VISITOR_HEADER)?.trim()
  if (!raw) return null
  const token = raw.toLowerCase().startsWith("bearer ") ? raw.slice(7).trim() : raw
  return token || null
}

/**
 * Reports who a stored visitor token belongs to.
 *
 * A widget that finds a token in storage has no way to know whether it expired,
 * was revoked from another tab, or was minted for a different source — so rather
 * than have it present the token to a submit and discover the answer by having a
 * comment rejected, it asks here first.
 *
 * `{ signedIn: false }` with a 200 for every failure, on purpose. An absent
 * token, a malformed one, an expired one, one revoked elsewhere, and one minted
 * for another source are all the same answer to the only question the widget is
 * asking, and the recovery is identical: offer to sign in. A 401 would invite a
 * widget to treat "not signed in yet" as an error state.
 */
export async function GET(request: NextRequest) {
  try {
    const source = await authorize(request)
    await consumeEmbedRate(source.tokenId, "READ")

    const token = readVisitorHeader(request)
    const identity = token ? await resolveEmbedVisitorToken(token, source.sourceId) : null
    if (!identity) return embedJson({ signedIn: false }, METHODS)

    void touchEmbedToken(source.tokenId)
    // The email and display name, and nothing else. No portalAccountId: the
    // widget has no use for an internal identifier, and this response is
    // readable by every script on the embedding page.
    return embedJson({ signedIn: true, email: identity.email, name: identity.name }, METHODS)
  } catch (error) {
    return errorResponse(error)
  }
}

/**
 * Sign-out. Idempotent, and deliberately incurious: a token that was already
 * revoked, has expired, or was minted for another source all produce the same
 * success, because in every case the caller's request — stop honouring this —
 * holds afterward. Reporting which of those it was would make sign-out an oracle
 * for whether a given token had ever been live.
 *
 * Note this revokes only the visitor session, not the portal session on the
 * Compass origin. Signing out of the widget must not sign the visitor out of the
 * roadmap portal in another tab, which is a second reason the widget holds its
 * own narrow credential rather than the portal cookie.
 */
export async function DELETE(request: NextRequest) {
  try {
    const source = await authorize(request)
    await consumeEmbedRate(source.tokenId, "READ")

    const token = readVisitorHeader(request)
    // The prefix check keeps an arbitrary string out of a hash-and-update. The
    // library re-checks it; this one keeps the work off the database.
    if (token?.startsWith(EMBED_VISITOR_TOKEN_PREFIX)) {
      await revokeEmbedVisitorToken(token)
    }

    // The same shape GET returns, so a widget can feed either response through
    // one code path to arrive at its signed-out state.
    return embedJson({ signedIn: false }, METHODS)
  } catch (error) {
    return errorResponse(error)
  }
}
