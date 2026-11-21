import type { ArtifactGalleryConfig } from "../widgets/artifact-gallery"
import type { WidgetResolution } from "../data"
import { surfaceBase, type ResolveContext } from "./context"

/**
 * Team audience only. Artifacts are internal working material with no public surface, so a customer resolution
 * is unavailable BEFORE any query runs: nothing is read, nothing can be serialized to the portal.
 * "selected" keeps the admin's order and drops ids that are archived, deleted or from another workspace.
 */
export async function resolveArtifactGallery(ctx: ResolveContext, config: ArtifactGalleryConfig): Promise<WidgetResolution> {
  if (ctx.audience !== "team") return { available: false, reason: "Artifacts are internal and are not shown to customers." }
  const selected = config.mode === "selected"
  if (selected && config.artifactIds.length === 0) return { available: false, reason: "No artifacts selected yet." }
  const found = await ctx.prisma.artifact.findMany({
    where: { workspaceId: ctx.workspace.id, status: "ACTIVE", ...(selected ? { id: { in: config.artifactIds } } : {}) },
    ...(selected ? {} : { orderBy: [{ updatedAt: "desc" as const }], take: config.maxItems }),
    select: {
      id: true,
      title: true,
      kind: true,
      sourceType: true,
      updatedAt: true,
      currentRevisionId: true,
      currentRevision: { select: { artifactId: true, thumbnailPathname: true } },
    },
  })
  const rows = selected
    ? config.artifactIds.flatMap((id) => found.filter((row) => row.id === id)).slice(0, config.maxItems)
    : found
  if (rows.length === 0) return { available: false, reason: selected ? "None of the selected artifacts are active." : "No artifacts yet." }
  const base = surfaceBase(ctx)
  return {
    available: true,
    data: {
      type: "artifact_gallery",
      galleryHref: `${base}/docs`,
      artifacts: rows.map((row) => ({
        id: row.id,
        title: row.title,
        kind: row.kind,
        sourceType: row.sourceType,
        updatedAt: row.updatedAt.toISOString(),
        href: `${base}/docs/artifacts/${row.id}`,
        thumbnailSrc: row.currentRevisionId && row.currentRevision?.artifactId === row.id && row.currentRevision.thumbnailPathname ? `/api/artifacts/${row.id}/revisions/${row.currentRevisionId}/thumbnail` : null,
      })),
    },
  }
}
