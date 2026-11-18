import { del, get, put } from "@vercel/blob"
import type { ArtifactStorage } from "@/lib/storage/types"

/** Private Vercel Blob store. The token is resolved lazily, per call, so a missing one fails at I/O. */
export function createVercelBlobStorage(token: string | (() => string)): ArtifactStorage {
  const tokenOptions = () => ({ token: typeof token === "function" ? token() : token })
  return {
    async put(pathname, bytes, contentType = "text/html; charset=utf-8", options) {
      const noOverwrite = options?.overwrite === false
      try {
        const result = await put(pathname, Buffer.from(bytes), {
          access: "private",
          contentType,
          addRandomSuffix: false,
          ...(noOverwrite ? { allowOverwrite: false } : {}),
          ...tokenOptions(),
        })
        return noOverwrite ? { pathname: result.pathname, created: true } : { pathname: result.pathname }
      } catch (error) {
        if (noOverwrite && /already exists/i.test((error as Error | null)?.message ?? "")) return { pathname, created: false }
        throw error
      }
    },
    async get(pathname) {
      const result = await get(pathname, { access: "private", useCache: false, ...tokenOptions() })
      if (!result || result.statusCode !== 200) return null
      return new Uint8Array(await new Response(result.stream).arrayBuffer())
    },
    async getStream(pathname) {
      const result = await get(pathname, { access: "private", useCache: false, ...tokenOptions() })
      if (!result || result.statusCode !== 200) return null
      return { stream: result.stream, size: result.blob.size }
    },
    async del(pathname) {
      await del(pathname, tokenOptions())
    },
  }
}
