import { del, put } from "@vercel/blob"
import type { PublicFileStore } from "@/lib/storage/public-store"

/** {@link PublicFileStore} on Vercel Blob. */
export const vercelBlobPublicFileStore: PublicFileStore = {
  async put(pathname, body, options = {}) {
    const blob = await put(pathname, body instanceof Blob ? body : Buffer.from(body), {
      access: "public",
      ...(options.contentType !== undefined ? { contentType: options.contentType } : {}),
      ...(options.addRandomSuffix !== undefined ? { addRandomSuffix: options.addRandomSuffix } : {}),
    })
    return { url: blob.url }
  },
  async delete(urls) {
    if (urls.length) await del(urls)
  },
  async fetch(url) {
    const res = await fetch(url)
    if (!res.ok) return null
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    }
  },
}
