import { z } from "zod"
import { requiredText, uuidLike } from "../fields"

export const ARTIFACT_GALLERY_MAX_ITEMS = 12
export const ARTIFACT_GALLERY_MODES = ["recent", "selected"] as const

/**
 * Team-only gallery of the workspace's active Artifacts (prototypes, decks, links). "recent" shows the newest;
 * "selected" shows only the chosen ids, in the admin's order, silently dropping any that are archived or gone.
 * Add several of these widgets to group different artifacts. Artifacts are internal, so the customer resolver
 * never returns data for this widget (see resolvers/artifact-gallery.ts).
 */
export const artifactGalleryConfig = z.object({
  title: requiredText(80),
  maxItems: z.number().int().min(1).max(ARTIFACT_GALLERY_MAX_ITEMS).default(6),
  mode: z.enum(ARTIFACT_GALLERY_MODES).default("recent"),
  artifactIds: z.array(uuidLike).max(ARTIFACT_GALLERY_MAX_ITEMS).default([]),
})
export type ArtifactGalleryConfig = z.infer<typeof artifactGalleryConfig>

export const artifactGalleryDefinition = {
  type: "artifact_gallery" as const,
  label: "Artifact gallery",
  description: "Recent or hand-picked prototypes and decks (team only)",
  defaultSize: "M" as const,
  configSchema: artifactGalleryConfig,
  defaultConfig: (): ArtifactGalleryConfig => ({ title: "Artifacts", maxItems: 6, mode: "recent", artifactIds: [] }),
}
