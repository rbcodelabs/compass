/**
 * Server-side half of the shared gallery artifact hero. Both gallery loaders resolve "which
 * artifacts belong to which card" their own way (solution links, experiment links) and hand
 * that here; this does the one batched artifact query and the shaping.
 */
import type { AppTransactionClient } from "@/lib/db"
import { toThumbnailDto } from "@/lib/artifacts"
import { readArtifactKind } from "@/lib/artifact-kind"
import { MAX_GALLERY_ARTIFACTS_PER_ITEM, isCapturableSource, type GalleryArtifactSet } from "@/lib/gallery/artifacts"

/**
 * Resolves each owner's linked artifact ids to gallery artifacts: ACTIVE only, scoped to the workspace,
 * newest first, de-duplicated, capped at MAX_GALLERY_ARTIFACTS_PER_ITEM with the remainder counted.
 * One artifact query regardless of owner count; none when no owner has an artifact. Every owner in the
 * input gets an entry (empty when it has nothing live).
 */
export async function loadGalleryArtifactSets(
  db: AppTransactionClient,
  workspaceId: string,
  artifactIdsByOwner: ReadonlyMap<string, readonly string[]>,
): Promise<Map<string, GalleryArtifactSet>> {
  const allArtifactIds = [...new Set([...artifactIdsByOwner.values()].flat())]
  const artifacts = allArtifactIds.length === 0
    ? []
    : await db.artifact.findMany({
        where: { workspaceId, id: { in: allArtifactIds }, status: "ACTIVE" },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        select: {
          id: true,
          title: true,
          sourceType: true,
          kind: true,
          currentRevision: {
            select: { id: true, thumbnailPathname: true, thumbnailWidth: true, thumbnailHeight: true, thumbnailCapturedAt: true },
          },
        },
      })
  // The query's order is the newest-first order; rank by it so each owner's list keeps it.
  const rank = new Map(artifacts.map((artifact, index) => [artifact.id, index]))
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]))

  const sets = new Map<string, GalleryArtifactSet>()
  for (const [owner, ids] of artifactIdsByOwner) {
    const linked = [...new Set(ids)]
      .map((id) => byId.get(id))
      .filter((artifact): artifact is NonNullable<typeof artifact> => !!artifact)
      .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
    sets.set(owner, {
      artifacts: linked.slice(0, MAX_GALLERY_ARTIFACTS_PER_ITEM).map((artifact) => ({
        id: artifact.id,
        title: artifact.title,
        sourceType: artifact.sourceType,
        kind: readArtifactKind(artifact.kind),
        thumbnail: artifact.currentRevision ? toThumbnailDto(artifact.id, artifact.currentRevision) : null,
        capturable: isCapturableSource(artifact.sourceType),
      })),
      moreArtifacts: Math.max(0, linked.length - MAX_GALLERY_ARTIFACTS_PER_ITEM),
    })
  }
  return sets
}
