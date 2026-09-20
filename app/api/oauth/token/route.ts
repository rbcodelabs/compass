/**
 * `POST /api/oauth/token` — `authorization_code` and `refresh_token` grants.
 *
 * Claude enforces a **10 s** timeout here (30 s on refresh), against a cold
 * Vercel function plus a DSQL IAM-signed connection, so this is deliberately
 * the leanest path in the authorization server: no session lookup, no
 * membership resolution, no logging round trip. The authorization-code grant
 * costs one conditional update, one read, and two inserts.
 *
 * ## Ordering
 *
 * The code is **claimed before it is validated**. A wrong `code_verifier`
 * therefore burns the code rather than leaving it spendable — a single-use code
 * that survives a failed exchange is an oracle an attacker can retry against.
 * See `lib/oauth/codes.ts` for why the claim is a conditional update and never
 * a read-then-write.
 */
import { NextResponse } from "next/server"
import { oauthErrorResponse } from "@/lib/oauth/errors"
import {
  OAUTH_NO_STORE_HEADERS,
  corsPreflightResponse,
  firstDuplicateParameter,
  formField,
  readFormBody,
  withCors,
} from "@/lib/oauth/http"
import {
  GRANT_AUTHORIZATION_CODE,
  GRANT_REFRESH_TOKEN,
  clientSecretMatches,
  findOAuthClient,
  touchOAuthClient,
  type RegisteredClient,
} from "@/lib/oauth/clients"
import { claimAuthorizationCode } from "@/lib/oauth/codes"
import { claimRefreshToken, issueTokenPair, revokeTokenFamily } from "@/lib/oauth/grants"
import { verifyPkce } from "@/lib/oauth/pkce"
import { resolveResource } from "@/lib/oauth/resource"
import { hashOAuthToken, isOAuthRefreshToken } from "@/lib/oauth/tokens"
import { parseScope } from "@/lib/oauth/constants"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Every parameter either grant reads. Repeating any of them is a 400. */
const TOKEN_PARAMETERS = [
  "grant_type",
  "client_id",
  "client_secret",
  "code",
  "redirect_uri",
  "code_verifier",
  "refresh_token",
  "scope",
  "resource",
] as const

const fail = (
  error: Parameters<typeof oauthErrorResponse>[0],
  description: string,
  status = 400,
) => withCors(oauthErrorResponse(error, description, status), "POST")

export async function POST(request: Request) {
  let params: URLSearchParams
  try {
    params = await readFormBody(request)
  } catch {
    return fail("invalid_request", "Request body is too large or unreadable.")
  }

  // RFC 6749 §3.1 forbids a repeated parameter, and `formField` reports one as
  // absent — which would quietly turn a duplicated `redirect_uri` into "the
  // client did not send one", skipping the check against the stored value.
  const duplicated = firstDuplicateParameter(params, TOKEN_PARAMETERS)
  if (duplicated) {
    return fail("invalid_request", `The ${duplicated} parameter was supplied more than once.`)
  }

  const grantType = formField(params, "grant_type")
  if (!grantType) return fail("invalid_request", "grant_type is required.")
  if (grantType !== GRANT_AUTHORIZATION_CODE && grantType !== GRANT_REFRESH_TOKEN) {
    return fail(
      "unsupported_grant_type",
      `Unsupported grant_type "${grantType}". This server supports ${GRANT_AUTHORIZATION_CODE} and ${GRANT_REFRESH_TOKEN}.`,
    )
  }

  const client = await authenticateClient(params)
  if (!client.ok) return fail("invalid_client", client.description, 401)
  if (!client.value.grantTypes.includes(grantType)) {
    return fail("unauthorized_client", `This client is not registered for the ${grantType} grant.`)
  }

  const response =
    grantType === GRANT_AUTHORIZATION_CODE
      ? await authorizationCodeGrant(params, client.value)
      : await refreshTokenGrant(params, client.value)

  // Fire-and-forget: `lastUsedAt` drives phase-2 TTL pruning and must not add
  // latency to a request Claude times out at 10 s.
  void touchOAuthClient(client.value.clientId)
  return response
}

export async function OPTIONS() {
  return corsPreflightResponse("POST")
}

type ClientAuth = { ok: true; value: RegisteredClient } | { ok: false; description: string }

/**
 * Authenticates the client from the request body.
 *
 * `client_secret_basic` is not accepted, because it is not advertised: the AS
 * metadata lists `client_secret_post` and `none` only. A public client
 * authenticates with `client_id` alone — which is the defined shape of a public
 * client, and the reason PKCE is mandatory rather than optional here.
 */
async function authenticateClient(params: URLSearchParams): Promise<ClientAuth> {
  const clientId = formField(params, "client_id")
  if (!clientId) return { ok: false, description: "client_id is required." }

  const client = await findOAuthClient(clientId)
  // Same message either way — an unknown client_id and a wrong secret must not
  // be distinguishable, or this endpoint enumerates registered clients.
  if (!client) return { ok: false, description: "Client authentication failed." }
  if (!clientSecretMatches(client, formField(params, "client_secret"))) {
    return { ok: false, description: "Client authentication failed." }
  }
  return { ok: true, value: client }
}

async function authorizationCodeGrant(
  params: URLSearchParams,
  client: RegisteredClient,
): Promise<NextResponse> {
  const code = formField(params, "code")
  if (!code) return fail("invalid_request", "code is required.")

  const claim = await claimAuthorizationCode(code)
  if (!claim.ok) {
    if (claim.reason === "replayed") {
      // OAuth 2.1 §4.1.3: a second exchange of a consumed code means the code
      // leaked, so everything it produced is revoked. `familyId` is the code's
      // own row id, which is what makes this reachable from the code alone.
      await revokeTokenFamily(claim.familyId)
      return fail(
        "invalid_grant",
        "This authorization code has already been used. Tokens issued from it have been revoked.",
      )
    }
    return fail("invalid_grant", "The authorization code is invalid, expired, or already used.")
  }
  const stored = claim.code

  if (stored.clientId !== client.clientId) {
    // A code presented by a client other than the one it was issued to. Revoke
    // rather than merely refuse: either the code leaked, or one of the two
    // clients is compromised.
    await revokeTokenFamily(stored.id)
    return fail("invalid_grant", "This authorization code was issued to a different client.")
  }
  if (stored.expiresAt.getTime() <= Date.now()) {
    return fail("invalid_grant", "The authorization code has expired.")
  }

  // OAuth 2.1 §4.1.3: identical to the value in the authorization request.
  // Exact comparison, not redirectUriMatches — the loopback port carve-out
  // exists to reconcile *registration* against *authorization*, and within a
  // single flow the client already committed to one concrete URI.
  const redirectUri = formField(params, "redirect_uri")
  if (redirectUri !== null && redirectUri !== stored.redirectUri) {
    return fail("invalid_grant", "redirect_uri does not match the authorization request.")
  }

  const pkce = verifyPkce({
    codeChallenge: stored.codeChallenge,
    codeChallengeMethod: stored.codeChallengeMethod,
    codeVerifier: formField(params, "code_verifier"),
  })
  if (!pkce.ok) return fail(pkce.error, pkce.description)

  // `resource` is optional here exactly as it is at authorize; when present it
  // must name the one audience this server mints for, and must also agree with
  // what the authorization request bound.
  const resource = resolveResource(formField(params, "resource"))
  if (!resource.ok) return fail(resource.error, resource.description)
  if (resource.resource !== stored.resource) {
    return fail("invalid_target", "resource does not match the authorization request.")
  }

  const tokens = await issueTokenPair({
    clientId: client.clientId,
    userId: stored.userId,
    scope: stored.scope,
    resource: stored.resource,
    familyId: stored.id,
  })
  return tokenResponse(tokens)
}

async function refreshTokenGrant(
  params: URLSearchParams,
  client: RegisteredClient,
): Promise<NextResponse> {
  const presented = formField(params, "refresh_token")
  if (!presented) return fail("invalid_request", "refresh_token is required.")
  // Structural check first: a value that is not shaped like one of our refresh
  // tokens cannot match any row, so this skips a database round trip on
  // garbage input without changing the answer.
  if (!isOAuthRefreshToken(presented)) {
    return fail("invalid_grant", "The refresh token is invalid, expired, or has been revoked.")
  }

  const claim = await claimRefreshToken(hashOAuthToken(presented))
  if (!claim.ok) {
    if (claim.reason === "reused") {
      return fail(
        "invalid_grant",
        "This refresh token has already been rotated. The whole token family has been revoked; re-authorize to continue.",
      )
    }
    return fail("invalid_grant", "The refresh token is invalid, expired, or has been revoked.")
  }
  const previous = claim.token

  if (previous.clientId !== client.clientId) {
    await revokeTokenFamily(previous.familyId)
    return fail("invalid_grant", "This refresh token was issued to a different client.")
  }

  // RFC 6749 §6: a requested scope must be a subset of the original grant.
  const requested = formField(params, "scope")
  const granted = parseScope(previous.scope)
  let scope = previous.scope
  if (requested) {
    const asked = parseScope(requested)
    if (!asked.every((entry) => granted.includes(entry))) {
      return fail("invalid_scope", "A refreshed token cannot widen the scope of the original grant.")
    }
    scope = asked.join(" ")
  }

  const resource = resolveResource(formField(params, "resource"))
  if (!resource.ok) return fail(resource.error, resource.description)
  if (resource.resource !== previous.resource) {
    return fail("invalid_target", "resource does not match the original grant.")
  }

  const tokens = await issueTokenPair({
    clientId: client.clientId,
    userId: previous.userId,
    scope,
    resource: previous.resource,
    // Same family, so a later replay of *any* member still takes the whole
    // chain down, and `parentTokenId` records the rotation lineage.
    familyId: previous.familyId,
    parentTokenId: previous.id,
    scopeWorkspaceId: previous.scopeWorkspaceId,
  })
  return tokenResponse(tokens)
}

function tokenResponse(body: object): NextResponse {
  return withCors(NextResponse.json(body, { headers: OAUTH_NO_STORE_HEADERS }), "POST")
}
