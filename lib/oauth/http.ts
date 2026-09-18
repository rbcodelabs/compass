/**
 * Shared HTTP plumbing for the unauthenticated OAuth endpoints: CORS, the
 * `CompassUrlNotConfiguredError` boundary, and form-body parsing.
 *
 * ## Why `Access-Control-Allow-Origin: *` is correct here
 *
 * It looks alarming and is not. Every endpoint that uses these headers —
 * the two discovery documents, `/register`, `/token`, `/revoke` — is
 * unauthenticated by design and carries no ambient authority: no cookie, no
 * session, no `Authorization` header is consulted. `Allow-Credentials` is never
 * set, so a browser will not attach cookies to these cross-origin requests even
 * if one existed. A wildcard therefore grants an attacker page exactly what it
 * could already get from its own server with `fetch`.
 *
 * The endpoints that *do* carry ambient authority — `/oauth/authorize` and
 * `/oauth/consent`, which run under the Auth.js session cookie — deliberately
 * have no CORS headers at all and are same-origin only.
 */
import { NextResponse } from "next/server"
import { CompassUrlNotConfiguredError } from "@/lib/compass-url"
import { OAUTH_NO_STORE_HEADERS, oauthConfigurationErrorResponse } from "@/lib/oauth/errors"

/**
 * The MCP SDK's `metadataCorsOptionsRequestHandler` equivalent. `mcp-protocol-version`
 * is in the allow list because MCP clients send it on discovery requests and a
 * browser preflight fails without it.
 */
export const OAUTH_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, mcp-protocol-version",
  "Access-Control-Max-Age": "86400",
}

export function corsPreflightResponse(methods: string): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: { ...OAUTH_CORS_HEADERS, "Access-Control-Allow-Methods": `${methods}, OPTIONS` },
  })
}

/**
 * Serves a discovery document.
 *
 * These are the only OAuth responses that are *not* `no-store`. They are pure,
 * world-readable config, and letting the Vercel edge serve a repeat discovery
 * from cache is the cheapest available defence against the 10 s cold-start
 * timeout. An hour is short enough that a config change propagates the same day
 * and long enough to absorb a client reconnect loop.
 */
export function metadataResponse(document: Record<string, unknown>): NextResponse {
  return NextResponse.json(document, {
    headers: {
      ...OAUTH_CORS_HEADERS,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  })
}

/**
 * Runs a metadata builder, converting an unresolvable deployment origin into a
 * 500 rather than letting it become an unhandled exception.
 *
 * A *configured but unsafe* origin (bad protocol, credentials in the URL) is a
 * plain `Error` and is intentionally **not** caught — that is a misconfiguration
 * which must surface loudly, and `lib/compass-url.ts` draws exactly this
 * distinction for every other caller too.
 */
export function withMetadataConfiguration(
  build: () => Record<string, unknown>,
): NextResponse {
  try {
    return metadataResponse(build())
  } catch (error) {
    if (error instanceof CompassUrlNotConfiguredError) {
      return oauthConfigurationErrorResponse({
        ...OAUTH_CORS_HEADERS,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      })
    }
    throw error
  }
}

/** Caps how much of an unauthenticated request body this server will buffer. */
export const MAX_OAUTH_BODY_BYTES = 16 * 1024

/**
 * Reads at most {@link MAX_OAUTH_BODY_BYTES}, then stops. Mirrors the bounded
 * reader in app/api/preview-login/start/route.ts — every one of these endpoints
 * is reachable without a session, so none of them may buffer an unbounded body.
 */
export async function readBoundedBody(request: Request): Promise<string> {
  const reader = request.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > MAX_OAUTH_BODY_BYTES) {
        await reader.cancel()
        throw new Error("Body too large")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * Parses an `application/x-www-form-urlencoded` body.
 *
 * OAuth 2.1 §D.2 makes form encoding the *only* encoding for the token and
 * revocation endpoints, so JSON is not accepted there — being lenient would
 * mean every client gets to pick, and the ones that pick wrong would fail
 * against every other authorization server instead.
 */
export async function readFormBody(request: Request): Promise<URLSearchParams> {
  return new URLSearchParams(await readBoundedBody(request))
}

/** Re-exported so a route handler has one import for body reading and field reading. */
export { firstDuplicateParameter, singleParam as formField } from "@/lib/oauth/params"

/** Adds CORS to an already-built response, for the POST endpoints. */
export function withCors(response: NextResponse, methods: string): NextResponse {
  for (const [key, value] of Object.entries(OAUTH_CORS_HEADERS)) {
    response.headers.set(key, value)
  }
  response.headers.set("Access-Control-Allow-Methods", `${methods}, OPTIONS`)
  return response
}

export { OAUTH_NO_STORE_HEADERS }
