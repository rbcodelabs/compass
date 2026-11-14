import { randomUUID } from "node:crypto"

/**
 * Workspace branding logos: what may be uploaded and which stored URLs
 * `updateWorkspaceBranding` may save.
 *
 * Raster only. SVG is excluded on purpose because it can carry script. The type
 * is decided from the file's magic bytes, never from the client-supplied
 * `file.type` or `file.name`.
 */
export const BRANDING_LOGO_MAX_BYTES = 10 * 1024 * 1024

export type BrandingLogoType = {
  contentType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"
  ext: "png" | "jpg" | "webp" | "gif"
}

export function sniffBrandingLogoType(bytes: Uint8Array): BrandingLogoType | null {
  const at = (i: number, ...sig: number[]) => sig.every((b, k) => bytes[i + k] === b)
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { contentType: "image/png", ext: "png" }
  if (at(0, 0xff, 0xd8, 0xff)) return { contentType: "image/jpeg", ext: "jpg" }
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return { contentType: "image/gif", ext: "gif" }
  }
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return { contentType: "image/webp", ext: "webp" }
  return null
}

/** Server-generated pathname: a fresh UUID and a fixed name, so nothing the client chose reaches the key. */
export function brandingLogoPathname(type: BrandingLogoType): string {
  return `branding/${randomUUID()}-logo.${type.ext}`
}

const BLOB_HOST_SUFFIX = ".public.blob.vercel-storage.com"

/** This deployment's public Blob store host, from BLOB_READ_WRITE_TOKEN (`vercel_blob_rw_<storeId>_<secret>`); null when Blob is not configured. */
function ownBlobHost(env: Record<string, string | undefined> = process.env): string | null {
  const storeId = /^vercel_blob_rw_([A-Za-z0-9]+)_/.exec(env.BLOB_READ_WRITE_TOKEN ?? "")?.[1]
  return storeId ? `${storeId.toLowerCase()}${BLOB_HOST_SUFFIX}` : null
}

/**
 * True only for a logo this deployment's own public store could have issued: an
 * https URL under `branding/` on THIS deployment's Blob store host. Other hosts,
 * other stores, `javascript:`/`data:` URLs, credentials, ports, queries and
 * fragments are all refused.
 */
export function isOwnBrandingLogoUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      url.hostname === ownBlobHost() &&
      url.pathname.startsWith("/branding/") &&
      !url.pathname.includes("..")
    )
  } catch {
    return false
  }
}
