import { headers } from "next/headers"
import { fetchV0Preview } from "@/lib/v0-artifacts"
import { normalizeEmbedder, previewFrameSrc } from "@/lib/v0-preview-proxy"

/**
 * The iframe `src` for a V0_CHAT artifact's running app, or null (previews not
 * configured, v0 not connected, no preview yet). Fetched with the viewer's own v0
 * grant on every view; the result is a ticket URL on the preview host that frames
 * only from the origin this request was served on.
 */
export async function livePreviewSrcFor(userId: string, chatId: string): Promise<string | null> {
  const preview = await fetchV0Preview(userId, chatId)
  if (!preview) return null
  const incoming = await headers()
  const host = incoming.get("x-forwarded-host") ?? incoming.get("host")
  const proto = incoming.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https")
  return previewFrameSrc(preview, host ? normalizeEmbedder(`${proto}://${host}`) : null)
}
