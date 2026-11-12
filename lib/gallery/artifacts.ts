/**
 * The pure, client-safe half of the artifact hero shared by the Roadmap and Experiments
 * Galleries: the per-card artifact DTO and its limits. The DB loader lives in
 * ./artifacts-server so client components can import this without bundling the DB layer.
 */
import type { ArtifactKind } from "@/lib/artifact-kind"
import type { ArtifactThumbnailDto } from "@/lib/artifacts"

/** Keeps a card's payload (and filmstrip) bounded when an item has many artifacts. */
export const MAX_GALLERY_ARTIFACTS_PER_ITEM = 6

export type GalleryArtifact = {
  id: string
  title: string
  sourceType: string
  kind: ArtifactKind
  /** null = the artifact exists but no screenshot has been captured yet. */
  thumbnail: ArtifactThumbnailDto | null
  /** Only HTML uploads and external links can be screenshotted (see captureAndStoreArtifactThumbnail). */
  capturable: boolean
}

/** What a gallery card's hero needs: the (capped) artifacts and how many more were linked. */
export type GalleryArtifactSet = {
  artifacts: GalleryArtifact[]
  /** Artifacts linked beyond MAX_GALLERY_ARTIFACTS_PER_ITEM. */
  moreArtifacts: number
}

export function isCapturableSource(sourceType: string): boolean {
  return sourceType === "HTML_UPLOAD" || sourceType === "EXTERNAL_LINK"
}
