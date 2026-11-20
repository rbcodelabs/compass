import {
  getArtifactStorage,
  getResearchArtifactStorage,
  type ArtifactStorage,
} from "@/lib/artifact-storage"
import { getPublicFileStore } from "@/lib/storage/public-store"
import { resolveStorageBackend } from "@/lib/storage/config"
import { createS3Storage } from "@/lib/storage/s3"
import { isOwnFeedbackAttachmentUrl } from "@/lib/workspace-export/path-confinement"

/**
 * Storage the bundle reads from on export and writes to on import. Injected so
 * tests (and the local-disk dev mode) never need Vercel Blob credentials.
 */
export interface BlobAdapters {
  /** Artifact HTML, thumbnails and doc images (private artifact store). */
  artifact: ArtifactStorage
  /** Research attachments (private research store). */
  research: ArtifactStorage
  /** Feedback attachments use Blob URLs or the app's public file route. */
  fetchPublic(url: string, workspaceId: string): Promise<{ bytes: Uint8Array; contentType: string } | null>
  putPublic(pathname: string, bytes: Uint8Array, contentType: string): Promise<string>
  delPublic(url: string): Promise<void>
  claimImport?(workspaceId: string): Promise<() => Promise<void>>
}

export function defaultBlobAdapters(): BlobAdapters {
  const usesS3 = resolveStorageBackend() === "s3"
  const claimImport = usesS3
    ? (workspaceId: string) => createS3Storage("artifacts").claimStagedUpload!(`workspace-import-staging/claims/${workspaceId}`)
    : undefined
  return {
    ...(claimImport ? { claimImport } : {}),
    get artifact() {
      return usesS3 ? createS3Storage("artifacts", { strictReads: true }) : getArtifactStorage()
    },
    get research() {
      return usesS3 ? createS3Storage("research", { strictReads: true }) : getResearchArtifactStorage()
    },
    async fetchPublic(url, workspaceId) {
      return isOwnFeedbackAttachmentUrl(url, workspaceId) ? getPublicFileStore().fetch(url) : null
    },
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
