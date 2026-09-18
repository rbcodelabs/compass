/**
 * `POST /api/oauth/revoke` — RFC 7009 token revocation.
 *
 * Must work for a **public client**: the Geode broker posts `token`,
 * `token_type_hint` and `client_id` with no secret, which is exactly what a
 * loopback client can do.
 *
 * ## Why almost everything returns 200
 *
 * RFC 7009 §2.2 requires a 200 for an invalid, expired, already-revoked, or
 * simply unknown token. That is not laziness about error reporting — the
 * endpoint is unauthenticated for public clients, so any distinguishable
 * response turns it into a token oracle: an attacker holding a candidate value
 * could learn whether it is live. The client's goal ("this token must stop
 * working") is satisfied identically in every one of those cases.
 *
 * A token that belongs to a *different* client is also answered with 200
 * without being revoked, for the same reason and one more: otherwise any
 * registered client could revoke any other client's tokens by guessing.
 */
import { NextResponse } from "next/server"
import { oauthErrorResponse } from "@/lib/oauth/errors"
import {
  OAUTH_NO_STORE_HEADERS,
  corsPreflightResponse,
  formField,
  readFormBody,
  withCors,
} from "@/lib/oauth/http"
import { clientSecretMatches, findOAuthClient, touchOAuthClient } from "@/lib/oauth/clients"
import { findRevocationTarget, revokeTokenById, revokeTokenFamily } from "@/lib/oauth/grants"
import { hashOAuthToken, oauthTokenType } from "@/lib/oauth/tokens"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** RFC 7009 §2.2 — an empty 200 body. */
function acknowledged(): NextResponse {
  return withCors(new NextResponse(null, { status: 200, headers: OAUTH_NO_STORE_HEADERS }), "POST")
}

export async function POST(request: Request) {
  let params: URLSearchParams
  try {
    params = await readFormBody(request)
  } catch {
    return withCors(
      oauthErrorResponse("invalid_request", "Request body is too large or unreadable.", 400),
      "POST",
    )
  }

  const token = formField(params, "token")
  if (!token) {
    return withCors(oauthErrorResponse("invalid_request", "token is required.", 400), "POST")
  }

  // Client authentication failure is one of the two cases RFC 7009 does *not*
  // paper over with a 200 (§2.2.1), because the client needs to know its own
  // credentials are wrong rather than silently believing a token was revoked.
  const clientId = formField(params, "client_id")
  if (!clientId) {
    return withCors(oauthErrorResponse("invalid_client", "client_id is required.", 401), "POST")
  }
  const client = await findOAuthClient(clientId)
  if (!client || !clientSecretMatches(client, formField(params, "client_secret"))) {
    return withCors(
      oauthErrorResponse("invalid_client", "Client authentication failed.", 401),
      "POST",
    )
  }
  void touchOAuthClient(client.clientId)

  // `token_type_hint` is advisory only (RFC 7009 §2.1): tokens are looked up by
  // hash across both types, so a wrong hint costs nothing and a right one saves
  // nothing. Reading it and ignoring it is the specified behaviour.
  const type = oauthTokenType(token)
  if (!type) return acknowledged()

  const target = await findRevocationTarget(hashOAuthToken(token))
  if (!target.found || target.clientId !== client.clientId) return acknowledged()

  if (target.type === "REFRESH") {
    // RFC 7009 §2.1: revoking a refresh token SHOULD revoke the access tokens
    // issued from it. The family is exactly that set.
    await revokeTokenFamily(target.familyId)
  } else {
    // Revoking one access token deliberately leaves the refresh token alive —
    // a client dropping a single short-lived credential is not asking to end
    // the whole grant, and RFC 7009 does not cascade in this direction.
    await revokeTokenById(target.id)
  }
  return acknowledged()
}

export async function OPTIONS() {
  return corsPreflightResponse("POST")
}
