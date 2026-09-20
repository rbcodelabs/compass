/**
 * `POST /oauth/consent` — the approve/deny half of the authorization endpoint.
 *
 * Deliberately **not** in `isPublicPath`, like `/oauth/authorize`: it runs under
 * the Auth.js session and has no business being reachable without one.
 *
 * ## The only input is a signature
 *
 * The form posts `decision` and `request`, where `request` is the HMAC-signed
 * blob minted by the page. Everything that determines what gets issued — client,
 * redirect URI, scope, PKCE challenge, audience, `state` — is recovered from
 * inside that signature, not from form fields.
 *
 * Both properties that matters fall out of that one choice:
 *
 *  - **CSRF.** The blob is bound to `session.user.id`. A cross-site form has no
 *    way to mint one, and a blob captured from another user's screen fails
 *    verification. No separate token, no double-submit cookie.
 *  - **No tamper window.** There are no unsigned fields, so the redirect URI the
 *    user read on the consent screen is provably the redirect URI the code is
 *    sent to. Swapping `127.0.0.1` for `evil.com` between the screen and the
 *    submit is the canonical version of this attack and it has nowhere to land.
 *
 * The request is re-validated against the database anyway (`client_id` still
 * exists, `redirect_uri` still registered, scope still available). A signature
 * proves the request was authentic when it was rendered, not that it is still
 * authorized ten minutes later.
 */
import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { CompassUrlNotConfiguredError } from "@/lib/compass-url"
import {
  buildAuthorizationErrorUrl,
  buildAuthorizationSuccessUrl,
} from "@/lib/oauth/authorize-request"
import { findOAuthClient } from "@/lib/oauth/clients"
import { issueAuthorizationCode } from "@/lib/oauth/codes"
import {
  CONSENT_COOKIE_NAME,
  CONSENT_COOKIE_OPTIONS,
  buildConsentCookie,
  recordConsent,
  verifyAuthorizationRequest,
} from "@/lib/oauth/consent"
import { oauthConfigurationErrorResponse, oauthErrorResponse } from "@/lib/oauth/errors"
import { OAUTH_NO_STORE_HEADERS, formField, readFormBody } from "@/lib/oauth/http"
import { matchRedirectUri } from "@/lib/oauth/redirect-uri"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) {
    return oauthErrorResponse("access_denied", "You must be signed in to authorize an application.", 401)
  }

  let params: URLSearchParams
  try {
    params = await readFormBody(request)
  } catch {
    return oauthErrorResponse("invalid_request", "Request body is too large or unreadable.", 400)
  }

  const pending = verifyAuthorizationRequest(formField(params, "request"), userId)
  if (!pending) {
    // Covers a forged blob, one signed for a different user, and one that simply
    // expired. None of them is distinguishable to a legitimate client, and the
    // user's remedy is identical: start the authorization again.
    return oauthErrorResponse(
      "invalid_request",
      "This authorization request has expired or is not valid. Start again from the application.",
      400,
    )
  }

  // Re-check the client between render and submit. A client pruned or a
  // redirect URI de-registered in that window must not still receive a code.
  const client = await findOAuthClient(pending.clientId)
  if (!client || !matchRedirectUri(client.redirectUris, pending.redirectUri)) {
    return oauthErrorResponse(
      "invalid_client",
      "This application is no longer registered. Start again from the application.",
      400,
    )
  }

  let location: string
  try {
    if (formField(params, "decision") !== "allow") {
      // Anything that is not an explicit allow is a denial — a missing or
      // unexpected value must never be read as approval. `access_denied` is the
      // RFC 6749 §4.1.2.1 code, and the client is told rather than left hanging.
      location = buildAuthorizationErrorUrl({
        redirectUri: pending.redirectUri,
        error: "access_denied",
        description: "The user declined to authorize this application.",
        state: pending.state,
      })
      return redirectResponse(location)
    }

    await recordConsent(userId, pending.clientId, pending.scope)
    const { code } = await issueAuthorizationCode({ ...pending, userId })
    location = buildAuthorizationSuccessUrl({
      redirectUri: pending.redirectUri,
      code,
      state: pending.state,
    })
  } catch (error) {
    if (error instanceof CompassUrlNotConfiguredError) return oauthConfigurationErrorResponse()
    throw error
  }

  const response = redirectResponse(location)
  // Set only now, after an explicit approval — a GET of the authorize page
  // writes no cookies at all, so nothing a drive-by request can trigger leaves
  // state behind. See lib/oauth/consent.ts.
  const existing = request.headers
    .get("cookie")
    ?.split("; ")
    .find((entry) => entry.startsWith(`${CONSENT_COOKIE_NAME}=`))
    ?.slice(CONSENT_COOKIE_NAME.length + 1)
  response.cookies.set(
    CONSENT_COOKIE_NAME,
    buildConsentCookie(existing, userId, pending.clientId, pending.scope),
    CONSENT_COOKIE_OPTIONS,
  )
  return response
}

/**
 * 303, not 302. The browser arrived here by POST; 303 is the status that
 * mandates following up with a GET, which is what a `redirect_uri` — a loopback
 * callback server or a hosted callback page — is listening for.
 */
function redirectResponse(location: string): NextResponse {
  return NextResponse.redirect(location, { status: 303, headers: OAUTH_NO_STORE_HEADERS })
}
