import "server-only"
/**
 * Server-side loader for the roadmap Gallery view. Kept apart from ./gallery so the
 * client component can import the pure grouping helpers without bundling the DB layer.
 */
import type { AppTransactionClient } from "@/lib/db"
import { getSolutionsArtifactIds, toThumbnailDto } from "@/lib/artifacts"
import { readArtifactKind } from "@/lib/artifact-kind"
import { MAX_GALLERY_ARTIFACTS_PER_ITEM, isCapturableSource, type GalleryItemExtras } from "@/lib/roadmap/gallery"

/** Loads, for each roadmap item with a Solution, its Solution's status and linked Artifacts (newest first, screenshots resolved). */
export async function loadRoadmapGalleryExtras(
  db: AppTransactionClient,
  workspaceId: string,
  items: ReadonlyArray<{ id: string; solutionId: string | null }>,
): Promise<Record<string, GalleryItemExtras>> {
  const solutionIds = [...new Set(items.map((item) => item.solutionId).filter((id): id is string => !!id))]
  const extras: Record<string, GalleryItemExtras> = {}
  for (const item of items) extras[item.id] = { solutionStatus: null, artifacts: [], moreArtifacts: 0 }
  if (solutionIds.length === 0) return extras

  const [solutions, artifactIdsBySolution] = await Promise.all([
    db.solution.findMany({ where: { workspaceId, id: { in: solutionIds } }, select: { id: true, status: true } }),
    getSolutionsArtifactIds(db, workspaceId, solutionIds),
  ])
  const statusBySolution = new Map(solutions.map((solution) => [solution.id, solution.status]))

  const allArtifactIds = [...new Set([...artifactIdsBySolution.values()].flat())]
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
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]))

  for (const item of items) {
    if (!item.solutionId) continue
    const linked = (artifactIdsBySolution.get(item.solutionId) ?? [])
      .map((id) => byId.get(id))
      .filter((artifact): artifact is NonNullable<typeof artifact> => !!artifact)
      // byId is already newest-first; keep that order per item.
      .sort((a, b) => artifacts.indexOf(a) - artifacts.indexOf(b))
    extras[item.id] = {
      solutionStatus: statusBySolution.get(item.solutionId) ?? null,
      artifacts: linked.slice(0, MAX_GALLERY_ARTIFACTS_PER_ITEM).map((artifact) => ({
        id: artifact.id,
        title: artifact.title,
        sourceType: artifact.sourceType,
        kind: readArtifactKind(artifact.kind),
        thumbnail: artifact.currentRevision ? toThumbnailDto(artifact.id, artifact.currentRevision) : null,
        capturable: isCapturableSource(artifact.sourceType),
      })),
      moreArtifacts: Math.max(0, linked.length - MAX_GALLERY_ARTIFACTS_PER_ITEM),
    }
  }
  return extras
}

