/**
 * Shared HTTP plumbing for the embed endpoints: CORS, bounded body reading, and
 * JSON error shaping.
 *
 * ## Why `Access-Control-Allow-Origin: *` is correct here too
 *
 * This mirrors the argument in lib/oauth/http.ts, and the same three facts hold.
 * The embed endpoints consult no cookie and no Auth.js session; their only
 * credential is an `Authorization: Bearer cmpfb_…` header the embedding page
 * supplies deliberately. `Access-Control-Allow-Credentials` is never set, so a
 * browser will not attach a Compass session cookie to these requests even for a
 * reader who happens to be logged in — and Compass's session cookie is
 * `SameSite=Lax`, so it would not travel cross-site regardless.
 *
 * A wildcard therefore grants an attacker page exactly what it could already get
 * from its own server with `fetch`: nothing, unless it also holds a valid embed
 * token.
 *
 * The origin allowlist is NOT enforced by these headers, and must not be
 * confused with them. CORS is a browser-side read restriction; the allowlist is
 * a server-side authorization check performed in the route handler against the
 * `Origin` header, and it is what actually stops a stolen token from being used
 * from an arbitrary page. Reflecting the allowlist into
 * `Access-Control-Allow-Origin` would make the two look like one control and
 * would give a `curl` caller — which sends no `Origin` at all — a false sense of
 * being blocked.
 */
import { NextResponse } from "next/server"

export const EMBED_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
}

/** Embed responses are per-token and must never be shared by a cache. */
export const EMBED_NO_STORE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
}

export function embedCorsPreflight(methods: string): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: { ...EMBED_CORS_HEADERS, "Access-Control-Allow-Methods": `${methods}, OPTIONS` },
  })
}

/** Adds CORS + no-store to an already-built response. */
export function withEmbedCors(response: NextResponse, methods: string): NextResponse {
  for (const [key, value] of Object.entries({ ...EMBED_CORS_HEADERS, ...EMBED_NO_STORE_HEADERS })) {
    response.headers.set(key, value)
  }
  response.headers.set("Access-Control-Allow-Methods", `${methods}, OPTIONS`)
  return response
}

export function embedError(status: number, message: string, methods: string, extraHeaders?: Record<string, string>): NextResponse {
  const response = NextResponse.json({ error: message }, { status, headers: extraHeaders })
  return withEmbedCors(response, methods)
}

export function embedJson(body: unknown, methods: string, status = 200): NextResponse {
  return withEmbedCors(NextResponse.json(body, { status }), methods)
}

/** Caps how much of an embed request body this server will buffer. */
export const MAX_EMBED_BODY_BYTES = 32 * 1024

/**
 * Reads at most {@link MAX_EMBED_BODY_BYTES}, then stops. Same reasoning as
 * readBoundedBody in lib/oauth/http.ts: these routes are reachable without a
 * Compass session, so none of them may buffer an unbounded body.
 */
export async function readBoundedEmbedBody(request: Request): Promise<string> {
  const reader = request.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > MAX_EMBED_BODY_BYTES) {
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
