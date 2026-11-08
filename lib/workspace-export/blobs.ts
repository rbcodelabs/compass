import {
  getArtifactStorage,
  getResearchArtifactStorage,
  type ArtifactStorage,
} from "@/lib/artifact-storage"
import { getPublicFileStore } from "@/lib/storage/public-store"

/**
 * Storage the bundle reads from on export and writes to on import. Injected so
 * tests (and the local-disk dev mode) never need Vercel Blob credentials.
 */
export interface BlobAdapters {
  /** Artifact HTML, thumbnails and doc images (private artifact store). */
  artifact: ArtifactStorage
  /** Research attachments (private research store). */
  research: ArtifactStorage
  /** Feedback attachments live in the public store as absolute URLs. */
  fetchPublic(url: string): Promise<{ bytes: Uint8Array; contentType: string } | null>
  putPublic(pathname: string, bytes: Uint8Array, contentType: string): Promise<string>
  delPublic(url: string): Promise<void>
}

export function defaultBlobAdapters(): BlobAdapters {
  return {
    get artifact() {
      return getArtifactStorage()
    },
    get research() {
      return getResearchArtifactStorage()
    },
    fetchPublic: (url) => getPublicFileStore().fetch(url),
    async putPublic(pathname, bytes, contentType) {
      return (await getPublicFileStore().put(pathname, bytes, { contentType, addRandomSuffix: false })).url
    },
    async delPublic(url) {
      await getPublicFileStore().delete([url]).catch(() => undefined)
    },
  }
}

/** Doc images are referenced from doc text as `/api/docs/images/{workspaceId}/{imageName}`. */
export const DOC_IMAGE_URL = /\/api\/docs\/images\/([0-9a-f-]{36})\/([A-Za-z0-9._-]+)/gi

export function docImagePathname(workspaceId: string, imageName: string): string {
  return `docs/${workspaceId}/images/${imageName}`
}
