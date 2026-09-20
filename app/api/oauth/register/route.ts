/**
 * `POST /api/oauth/register` — Dynamic Client Registration (RFC 7591).
 *
 * Unauthenticated, and that is the design, not a gap. Registration happens
 * *before* any user is involved — the Geode broker calls `registerClient()` and
 * only then `authorize()` — so there is no session to gate it on, and requiring
 * one would break the primary consumer outright (decision 2). DCR is also the
 * only registration path: `client_id_metadata_document_supported` is not
 * advertised (decision 5) and there is no static client allowlist (decision 4),
 * so `registration_endpoint` is blocking for Geode, Claude, `mcp-remote`, and
 * Cursor alike.
 *
 * What an open endpoint actually grants is worth being precise about: one
 * bounded row, and a `client_id` that can reach the consent screen. It grants
 * no access to anything until a signed-in human reads that screen and approves.
 * The compensating controls are therefore the consent screen's unverified-client
 * treatment and redirect-host display (`app/oauth/authorize/page.tsx`), the
 * redirect-URI restrictions in `lib/oauth/clients.ts`, and the per-IP limit below.
 */
import { NextResponse } from "next/server"
import {
  corsPreflightResponse,
  readBoundedBody,
  withCors,
  OAUTH_NO_STORE_HEADERS,
} from "@/lib/oauth/http"
import { oauthErrorResponse } from "@/lib/oauth/errors"
import { createOAuthClient, validateRegistrationRequest } from "@/lib/oauth/clients"
import { checkRegistrationRateLimit, clientAddress } from "@/lib/oauth/rate-limit"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  // Before parsing, so an oversized or malformed body still costs a slot.
  const limit = checkRegistrationRateLimit(clientAddress(request))
  if (!limit.allowed) {
    return withCors(
      oauthErrorResponse(
        "invalid_client_metadata",
        "Too many registration attempts. Try again later.",
        429,
        { "Retry-After": String(limit.retryAfterSeconds) },
      ),
      "POST",
    )
  }

  let body: unknown
  try {
    const raw = await readBoundedBody(request)
    body = raw ? JSON.parse(raw) : {}
  } catch {
    return withCors(
      oauthErrorResponse("invalid_client_metadata", "Body must be valid JSON.", 400),
      "POST",
    )
  }

  const validated = validateRegistrationRequest(body)
  if (!validated.ok) {
    return withCors(oauthErrorResponse(validated.error, validated.description, 400), "POST")
  }

  const registered = await createOAuthClient(validated.metadata)
  // RFC 7591 §3.2.1: 201, and `no-store` because the body may contain a
  // client_secret for a client that registered with client_secret_post.
  return withCors(
    NextResponse.json(registered, { status: 201, headers: OAUTH_NO_STORE_HEADERS }),
    "POST",
  )
}

export async function OPTIONS() {
  return corsPreflightResponse("POST")
}
