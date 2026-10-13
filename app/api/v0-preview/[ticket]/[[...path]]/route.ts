import { expiredPreviewResponse, forwardPreviewRequest, openPreviewTicket, previewHost } from "@/lib/v0-preview-proxy"

/**
 * Serves a v0 chat's running app on the dedicated preview host (V0_PREVIEW_HOST).
 * `proxy.ts` rewrites `/p/<ticket>/<path>` on that host to this route; it answers
 * nothing on any other host, so it adds no surface to the Compass origin.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 60

type Context = { params: Promise<{ ticket: string; path?: string[] }> }

async function handle(req: Request, { params }: Context): Promise<Response> {
  const expected = previewHost()
  const host = req.headers.get("host")?.toLowerCase()
  if (!expected || host !== expected) return new Response("Not found", { status: 404 })

  const { ticket: rawTicket, path } = await params
  const opened = openPreviewTicket(rawTicket)
  if (!opened.ok) return expiredPreviewResponse(null, opened.reason === "expired" ? 410 : 404)

  const url = new URL(req.url)
  // Re-encode each segment: `params` is decoded, and the upstream path must round-trip byte for byte.
  const rest = `/${(path ?? []).map(encodeURIComponent).join("/")}`
  return forwardPreviewRequest(req, opened.ticket, `/p/${rawTicket}`, rest, url.search)
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE, handle as HEAD, handle as OPTIONS }
