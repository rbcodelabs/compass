/**
 * Server-side loader for the Experiments Gallery. Kept apart from ./gallery so the client
 * component can import the pure helpers without bundling the DB layer.
 */
import type { AppTransactionClient } from "@/lib/db"
import { getExperimentsArtifactIds } from "@/lib/artifacts"
import { loadGalleryArtifactSets } from "@/lib/gallery/artifacts-server"
import type { GalleryArtifactSet } from "@/lib/gallery/artifacts"

/**
 * Loads, for each experiment, its linked Artifacts (ACTIVE only, newest first, screenshots resolved, capped).
 * One link read and one artifact query for the whole page; an experiment with nothing linked gets an empty set.
 */
export async function loadExperimentGalleryExtras(
  db: AppTransactionClient,
  workspaceId: string,
  experimentIds: readonly string[],
): Promise<Record<string, GalleryArtifactSet>> {
  if (experimentIds.length === 0) return {}
  const artifactIdsByExperiment = await getExperimentsArtifactIds(db, workspaceId, experimentIds)
  const sets = await loadGalleryArtifactSets(db, workspaceId, new Map(experimentIds.map((id) => [id, artifactIdsByExperiment.get(id) ?? []])))
  return Object.fromEntries(sets)
}
