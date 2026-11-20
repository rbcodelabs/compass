import { NextRequest } from "next/server"
import { keyFromSegments, parseSingleRange } from "@/lib/storage/public-route"
import { getPublicObject, headPublicObject } from "@/lib/storage/s3"

/**
 * GET/HEAD /api/files/public/<key> -- the S3 backend's stand-in for a public
 * Vercel Blob URL.
 *
 * No session is required, on purpose: a Blob URL for these objects was already
 * readable by anyone holding it (feedback attachments in the public portal, the
 * workspace logo on the portal, embed element screenshots). The exposure is kept
 * identical, not widened:
 *
 *  - Only the `public` store is addressable. Private stores (artifacts, packs,
 *    research, agent sessions) have their own authorized routes and never come
 *    through here; there is no `/api/files/<other-store>/...`.
 *  - Only keys of a shape the server mints are served (lib/public-file-keys.ts),
 *    and each shape contains a random UUID, so a URL cannot be enumerated.
 *    Anything else is a 404, indistinguishable from a missing object.
 *  - The key is validated segment by segment before it is joined, so `..`,
 *    encoded separators and double-encoded dots never reach S3.
 *  - The read is pinned to the `public/` prefix inside lib/storage/s3.ts, so even a
 *    validation bug could not reach another prefix.
 *
 * Layers audited: proxy.ts lets exactly this key shape through (isPublicPath);
 * this handler re-validates; the bucket policy stays private.
 *
 * Active content: objects here are user-supplied. Only raster/SVG images are
 * rendered inline; everything else downloads. `Content-Security-Policy: sandbox`
 * gives even an SVG opened directly an opaque origin, so script in it cannot
 * touch Compass cookies; `nosniff` stops type guessing.
 */

export const runtime = "nodejs"

const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"])

type Params = { key: string[] }

function notFound(): Response {
  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  })
}

function baseName(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1)
}

function safeHeaders(key: string, storedType: string | undefined, etag: string | undefined): Headers {
  const mime = (storedType ?? "").split(";")[0]!.trim().toLowerCase()
  const inline = INLINE_TYPES.has(mime)
  const headers = new Headers()
  headers.set("Content-Type", inline ? mime : "application/octet-stream")
  headers.set("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${baseName(key)}"`)
  headers.set("X-Content-Type-Options", "nosniff")
  headers.set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:")
  headers.set("Referrer-Policy", "no-referrer")
  headers.set("Cross-Origin-Resource-Policy", key.startsWith("embed-feedback/") ? "cross-origin" : "same-site")
  // Keys carry a random UUID and are never rewritten, so the bytes behind one never change.
  headers.set("Cache-Control", "public, max-age=31536000, immutable")
  headers.set("Accept-Ranges", "bytes")
  if (etag) headers.set("ETag", etag)
  return headers
}

async function handle(request: NextRequest, context: { params: Promise<Params> }, headOnly: boolean): Promise<Response> {
  const key = keyFromSegments((await context.params).key)
  if (!key) return notFound()
  try {
    if (!process.env.COMPASS_S3_BUCKET?.trim()) return notFound()

    if (headOnly) {
      const head = await headPublicObject(key)
      if (!head) return notFound()
      const headers = safeHeaders(key, head.contentType, head.etag)
      if (head.contentLength !== undefined) headers.set("Content-Length", String(head.contentLength))
      if (head.etag && request.headers.get("if-none-match") === head.etag) return new Response(null, { status: 304, headers })
      return new Response(null, { status: 200, headers })
    }

    const range = parseSingleRange(request.headers.get("range"))
    const ifNoneMatch = request.headers.get("if-none-match")
    const read = await getPublicObject(key, {
      ...(range ? { range } : {}),
      ...(ifNoneMatch ? { ifNoneMatch } : {}),
    })
    if (read.kind === "not-found") return notFound()
    if (read.kind === "not-modified") {
      const headers = safeHeaders(key, undefined, read.etag)
      headers.delete("Content-Type")
      headers.delete("Content-Disposition")
      return new Response(null, { status: 304, headers })
    }
    if (read.kind === "invalid-range") {
      return new Response(null, { status: 416, headers: { "Content-Range": "bytes */*", "Cache-Control": "no-store" } })
    }
    const { result } = read
    if (!result.Body) return notFound()
    const headers = safeHeaders(key, result.ContentType, result.ETag)
    if (result.ContentLength !== undefined) headers.set("Content-Length", String(result.ContentLength))
    const partial = Boolean(result.ContentRange)
    if (result.ContentRange) headers.set("Content-Range", result.ContentRange)
    return new Response(result.Body.transformToWebStream(), { status: partial ? 206 : 200, headers })
  } catch (error) {
    console.error("Public file read failed", error)
    return new Response(JSON.stringify({ error: "File unavailable" }), {
      status: 502,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    })
  }
}

export async function GET(request: NextRequest, context: { params: Promise<Params> }) {
  return handle(request, context, false)
}

export async function HEAD(request: NextRequest, context: { params: Promise<Params> }) {
  return handle(request, context, true)
}
