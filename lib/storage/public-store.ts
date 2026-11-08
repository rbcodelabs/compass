import { del, put } from "@vercel/blob"

/**
 * The seam between Compass and whatever object store holds its *public* files
 * (feedback attachments, embed screenshots, branding logos). Callers use this
 * instead of `@vercel/blob`, so a deployment on another store swaps one
 * implementation rather than editing every caller.
 *
 * "Public" means the stored URL is shareable without a Compass session. The
 * private artifact and research stores are a separate seam
 * (`ArtifactStorage` in `lib/artifact-storage.ts`).
 *
 * Nothing outside this directory may import a storage SDK for public files.
 */
export interface PublicFileStore {
  /**
   * Store the bytes and return the URL they are served from. `addRandomSuffix`
   * appends an unguessable suffix to the pathname (use it when the pathname is
   * derivable from ids a client might know).
   */
  put(
    pathname: string,
    body: Uint8Array | Blob,
    options?: { contentType?: string; addRandomSuffix?: boolean },
  ): Promise<{ url: string }>
  /** Remove the objects behind these URLs. Throws on failure; callers decide whether cleanup is best-effort. */
  delete(urls: string[]): Promise<void>
  /** Read an object back by its URL. `null` when it is gone or unreadable. */
  fetch(url: string): Promise<{ bytes: Uint8Array; contentType: string } | null>
}

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

/** The active public store. One place decides; every caller goes through it. */
export function getPublicFileStore(): PublicFileStore {
  return vercelBlobPublicFileStore
}
