import { track } from "@vercel/analytics/server"
import { activityEventSchema, TELEMETRY_PATH, telemetryOrigin, verifyTelemetry } from "@/lib/analytics/telemetry"

export async function POST(request: Request) {
  const url = new URL(request.url)
  if (url.pathname !== TELEMETRY_PATH || url.search || url.origin !== telemetryOrigin()) return new Response(null, { status: 404 })
  if (Number(request.headers.get("content-length")) > 512) return new Response(null, { status: 413 })
  const reader = request.body?.getReader()
  if (!reader) return new Response(null, { status: 400 })
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > 512) { await reader.cancel(); return new Response(null, { status: 413 }) }
    chunks.push(value)
  }
  const body = Buffer.concat(chunks).toString("utf8")
  if (!verifyTelemetry(body, request.headers.get("x-activity-timestamp"), request.headers.get("x-activity-signature"))) return new Response(null, { status: 401 })
  let input: unknown
  try { input = JSON.parse(body) } catch { return new Response(null, { status: 400 }) }
  const event = activityEventSchema.safeParse(input)
  if (!event.success) return new Response(null, { status: 400 })
  // The SDK's requestContext.url can only be this fixed, query-free path.
  // Explicit headers suppress cookie/IP/browser metadata from the relay.
  try { await track("compass_activity", event.data, { headers: { "user-agent": "Compass-Activity-Relay", referer: url.origin + TELEMETRY_PATH } }) } catch { /* best effort */ }
  return new Response(null, { status: 204 })
}
