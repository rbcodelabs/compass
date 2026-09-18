/**
 * Validation of a `GET /oauth/authorize` request, and construction of the
 * authorization response.
 *
 * ## Two classes of failure, and why the split matters
 *
 * OAuth 2.1 §4.1.2.1 draws a line that is easy to miss and dangerous to get
 * wrong. If the `client_id` or the `redirect_uri` is invalid, the server
 * **MUST NOT** redirect — it has no verified place to send the user, and
 * redirecting anyway is precisely how an open redirect gets built. It must
 * instead tell the user directly. Every *other* failure is reported by
 * redirecting back to the (now verified) `redirect_uri` with an `error`
 * parameter, because that is the only channel the client is listening on.
 *
 * {@link AuthorizeValidation} encodes that as `kind: "fatal"` versus
 * `kind: "redirect"` so a caller cannot accidentally collapse the two.
 *
 * ## RFC 9207 `iss`
 *
 * Every authorization response this module builds — success *and* error —
 * carries `iss`. The AS metadata advertises
 * `authorization_response_iss_parameter_supported: true`, and advertising a
 * behaviour the server does not implement is worse than not advertising it:
 * a client that trusts the flag will reject a response that lacks the parameter.
 */
import { oauthIssuer } from "@/lib/oauth/constants"
import { filterSupportedScopes, formatScope, parseScope } from "@/lib/oauth/constants"
import type { OAuthErrorCode } from "@/lib/oauth/errors"
import { findOAuthClient, type RegisteredClient } from "@/lib/oauth/clients"
import { firstDuplicateParameter, singleParam as single } from "@/lib/oauth/params"
import { validateCodeChallenge } from "@/lib/oauth/pkce"
import { matchRedirectUri } from "@/lib/oauth/redirect-uri"
import { resolveResource } from "@/lib/oauth/resource"
import type { PendingAuthorizationRequest } from "@/lib/oauth/consent"

/** `OAuthAuthorizationCode.scope` is `VarChar(255)`. */
const MAX_SCOPE_LENGTH = 255
/** `state` is echoed, never stored — bounded only to keep the URL sane. */
const MAX_STATE_LENGTH = 2048

export type AuthorizeValidation =
  | { ok: true; request: PendingAuthorizationRequest; client: RegisteredClient }
  /** Unusable `client_id` or `redirect_uri` — show the user; never redirect. */
  | { ok: false; kind: "fatal"; error: OAuthErrorCode; description: string }
  /** Redirect back to the verified URI with an OAuth error. */
  | {
      ok: false
      kind: "redirect"
      redirectUri: string
      state: string | null
      error: OAuthErrorCode
      description: string
    }

/** Every parameter this endpoint reads. Repeating any of them is fatal. */
const AUTHORIZE_PARAMETERS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "state",
  "scope",
  "resource",
  "code_challenge",
  "code_challenge_method",
] as const

export async function validateAuthorizationRequest(
  params: URLSearchParams,
): Promise<AuthorizeValidation> {
  // Up front, and fatal, because a duplicate `redirect_uri` must not reach the
  // "client omitted it, default to the registered one" path below — see
  // firstDuplicateParameter in lib/oauth/http.ts.
  const duplicated = firstDuplicateParameter(params, AUTHORIZE_PARAMETERS)
  if (duplicated) {
    return {
      ok: false,
      kind: "fatal",
      error: "invalid_request",
      description: `The ${duplicated} parameter was supplied more than once.`,
    }
  }

  const clientId = single(params, "client_id")
  if (!clientId) {
    return { ok: false, kind: "fatal", error: "invalid_request", description: "client_id is required." }
  }

  const client = await findOAuthClient(clientId)
  if (!client) {
    // Deliberately the same message for "never registered" and "registered but
    // pruned": neither tells the user anything actionable, and distinguishing
    // them would turn this endpoint into a client-id oracle.
    return {
      ok: false,
      kind: "fatal",
      error: "invalid_client",
      description: "Unknown client_id. This application needs to register again.",
    }
  }

  const requestedRedirectUri = single(params, "redirect_uri")
  // RFC 6749 §3.1.2.3 permits omitting redirect_uri when exactly one is
  // registered. Every client Compass targets sends it; supporting the omission
  // costs one line and unblocks the ones that follow the older spec text.
  const candidate =
    requestedRedirectUri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : null)
  if (!candidate) {
    return {
      ok: false,
      kind: "fatal",
      error: "invalid_request",
      description: "redirect_uri is required because this client registered more than one.",
    }
  }
  // matchRedirectUri, not a hand-rolled comparison: exact string equality for
  // every ordinary client, plus the port-agnostic loopback exception that the
  // Geode broker (portless registration, ephemeral authorize port) requires.
  if (!matchRedirectUri(client.redirectUris, candidate)) {
    return {
      ok: false,
      kind: "fatal",
      error: "invalid_request",
      description: "redirect_uri does not match a registered redirect URI for this client.",
    }
  }
  // From here on the redirect URI is verified, so errors travel back to the client.
  const redirectUri = candidate
  const state = bounded(single(params, "state"), MAX_STATE_LENGTH)
  const fail = (error: OAuthErrorCode, description: string): AuthorizeValidation => ({
    ok: false,
    kind: "redirect",
    redirectUri,
    state,
    error,
    description,
  })

  const responseType = single(params, "response_type")
  if (responseType !== "code") {
    return fail(
      "unsupported_response_type",
      'response_type must be "code"; this server does not implement any other flow.',
    )
  }

  const codeChallenge = single(params, "code_challenge")
  const codeChallengeMethod = single(params, "code_challenge_method")
  const pkce = validateCodeChallenge(codeChallenge, codeChallengeMethod)
  if (!pkce.ok) return fail(pkce.error, pkce.description)

  const resource = resolveResource(single(params, "resource"))
  if (!resource.ok) return fail(resource.error, resource.description)

  const scope = resolveScope(single(params, "scope"), client.scope)
  if (!scope.ok) return fail("invalid_scope", scope.description)

  return {
    ok: true,
    client,
    request: {
      clientId: client.clientId,
      redirectUri,
      state,
      codeChallenge: codeChallenge!,
      codeChallengeMethod: codeChallengeMethod!,
      scope: scope.value,
      resource: resource.resource,
    },
  }
}

type ScopeResolution = { ok: true; value: string } | { ok: false; description: string }

/**
 * The granted scope is the intersection of what the client asked for, what the
 * client registered for, and what this server supports.
 *
 * An omitted `scope` grants the client's full registered scope, per RFC 6749
 * §3.3's default-scope allowance — the registration response already told the
 * client what that is, so nothing is granted the client did not see.
 */
export function resolveScope(requested: string | null, registeredScope: string): ScopeResolution {
  const registered = new Set(filterSupportedScopes(registeredScope))
  if (registered.size === 0) {
    return { ok: false, description: "This client is not registered for any supported scope." }
  }
  if (!requested) return { ok: true, value: bounded(formatScope([...registered]), MAX_SCOPE_LENGTH)! }

  const asked = parseScope(requested)
  const granted = asked.filter((scope) => registered.has(scope as never))
  if (granted.length === 0) {
    return {
      ok: false,
      description: `None of the requested scopes are available to this client. Available: ${[...registered].join(" ")}.`,
    }
  }
  return { ok: true, value: bounded(formatScope(granted), MAX_SCOPE_LENGTH)! }
}

export interface AuthorizationSuccess {
  redirectUri: string
  code: string
  state: string | null
}

export function buildAuthorizationSuccessUrl(input: AuthorizationSuccess): string {
  const url = new URL(input.redirectUri)
  url.searchParams.set("code", input.code)
  if (input.state !== null) url.searchParams.set("state", input.state)
  url.searchParams.set("iss", oauthIssuer())
  return url.toString()
}

export interface AuthorizationFailure {
  redirectUri: string
  error: OAuthErrorCode
  description: string
  state: string | null
}

export function buildAuthorizationErrorUrl(input: AuthorizationFailure): string {
  const url = new URL(input.redirectUri)
  url.searchParams.set("error", input.error)
  url.searchParams.set("error_description", input.description)
  if (input.state !== null) url.searchParams.set("state", input.state)
  url.searchParams.set("iss", oauthIssuer())
  return url.toString()
}

function bounded(value: string | null, max: number): string | null {
  if (value === null) return null
  return value.length > max ? value.slice(0, max) : value
}
