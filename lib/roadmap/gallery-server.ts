/**
 * Server-side loader for the roadmap Gallery view. Kept apart from ./gallery so the
 * client component can import the pure grouping helpers without bundling the DB layer.
 */
import type { AppTransactionClient } from "@/lib/db"
import { getSolutionsArtifactIds } from "@/lib/artifacts"
import { loadGalleryArtifactSets } from "@/lib/gallery/artifacts-server"
import type { GalleryItemExtras } from "@/lib/roadmap/gallery"

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

  const artifactSets = await loadGalleryArtifactSets(db, workspaceId, artifactIdsBySolution)

  for (const item of items) {
    if (!item.solutionId) continue
    const set = artifactSets.get(item.solutionId)
    extras[item.id] = {
      solutionStatus: statusBySolution.get(item.solutionId) ?? null,
      artifacts: set?.artifacts ?? [],
      moreArtifacts: set?.moreArtifacts ?? 0,
    }
  }
  return extras
}
