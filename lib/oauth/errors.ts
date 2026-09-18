/**
 * OAuth error responses (RFC 6749 §5.2, RFC 7591 §3.2.2, RFC 9728).
 *
 * One helper rather than an inline `NextResponse.json` per route, because three
 * things have to be true of *every* error this authorization server emits and
 * are easy to forget one at a time:
 *
 *  - `Cache-Control: no-store` — RFC 6749 §5.1 requires it on token responses
 *    and there is no reason to let any other OAuth response be cached either.
 *  - The body is `{ error, error_description }` with an `error` drawn from the
 *    registered set. Clients branch on `error`; a bare status code or a prose
 *    body leaves them unable to distinguish "retry" from "re-register".
 *  - `error_description` never echoes attacker-supplied input verbatim and
 *    never leaks deployment configuration. See {@link CONFIGURATION_ERROR}.
 */
import { NextResponse } from "next/server"

/**
 * The subset of the IANA OAuth Extensions Error Registry this server emits.
 * Typed as a union rather than `string` so a typo becomes a compile error
 * instead of an error code no client recognises.
 */
export type OAuthErrorCode =
  // RFC 6749 §4.1.2.1 (authorization endpoint) and §5.2 (token endpoint)
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "unsupported_response_type"
  | "invalid_scope"
  | "access_denied"
  | "server_error"
  | "temporarily_unavailable"
  // RFC 8707 §2.2 — the requested audience is not one this server issues for
  | "invalid_target"
  // RFC 7591 §3.2.2 (dynamic client registration)
  | "invalid_redirect_uri"
  | "invalid_client_metadata"
  // RFC 7009 §2.2.1 (revocation)
  | "unsupported_token_type"

/**
 * Headers every OAuth response carries. `Referrer-Policy` matters more here
 * than usual: the authorize endpoint's URL contains `code_challenge` and
 * `state`, and the consent screen may link out.
 */
export const OAUTH_NO_STORE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
}

export function oauthErrorResponse(
  error: OAuthErrorCode,
  description: string,
  status: number,
  extraHeaders: Record<string, string> = {},
): NextResponse {
  return NextResponse.json(
    { error, error_description: description },
    { status, headers: { ...OAUTH_NO_STORE_HEADERS, ...extraHeaders } },
  )
}

/**
 * The response for `CompassUrlNotConfiguredError` — the deployment cannot
 * resolve its own origin, so `oauthIssuer()` / `mcpResourceUri()` throw.
 *
 * **This is a 500, deliberately, and never a 404.** A 404 on a `.well-known`
 * document tells a client "this server does not support OAuth", which is false:
 * it would send the client down a no-authorization fallback path and produce a
 * confusing downstream failure instead of a legible one. A 500 says "this
 * server supports OAuth and is currently broken", which is the truth and is
 * retryable.
 *
 * Equally deliberate: the body says nothing about *which* variable is missing.
 * These documents are unauthenticated and world-readable.
 */
export const CONFIGURATION_ERROR_DESCRIPTION =
  "This deployment is not configured to issue OAuth tokens."

export function oauthConfigurationErrorResponse(
  extraHeaders: Record<string, string> = {},
): NextResponse {
  return oauthErrorResponse("server_error", CONFIGURATION_ERROR_DESCRIPTION, 500, extraHeaders)
}
