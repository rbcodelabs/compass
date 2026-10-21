/**
 * Compatibility shim over lib/saved-views/service.ts for the two roadmap surfaces.
 * The roadmap's historical "surface" argument is a workspace id, or null for the
 * org-level roadmap; it maps to ROADMAP_WORKSPACE / ROADMAP_ORG here. Behaviour is
 * unchanged. Kept for one release (ADR "Generic saved views", migration shim).
 */
import getPrisma from "@/lib/db"
import type { RoadmapViewActor, RoadmapViewSurface, RoadmapViewVisibility } from "@/lib/roadmap-views/access"
import type { RoadmapViewDisplay, RoadmapViewFilters } from "@/lib/roadmap-views/schema"
import {
  MAX_VIEWS_PER_OWNER_PER_SURFACE, createSavedView, deleteSavedView, getSavedView, listSavedViews,
  resolveSavedViewActor, updateSavedView, type SavedViewRecord,
} from "@/lib/saved-views/service"
import { roadmapSurfaceFor } from "@/lib/saved-views/surfaces"

type Db = ReturnType<typeof getPrisma>

export { MAX_VIEWS_PER_OWNER_PER_SURFACE }

export type RoadmapViewRecord = Omit<SavedViewRecord<RoadmapViewFilters, RoadmapViewDisplay>, "visibility"> & {
  visibility: RoadmapViewVisibility
}

export const resolveRoadmapViewActor = resolveSavedViewActor

export async function listRoadmapViews(actor: RoadmapViewActor, surface: RoadmapViewSurface, db: Db = getPrisma()): Promise<RoadmapViewRecord[]> {
  return (await listSavedViews(actor, roadmapSurfaceFor(surface), surface, db)) as RoadmapViewRecord[]
}

export async function getRoadmapView(actor: RoadmapViewActor, surface: RoadmapViewSurface, id: string, db: Db = getPrisma()): Promise<RoadmapViewRecord | null> {
  return (await getSavedView(actor, roadmapSurfaceFor(surface), surface, id, db)) as RoadmapViewRecord | null
}

export async function createRoadmapView(actor: RoadmapViewActor, surface: RoadmapViewSurface, input: unknown, db: Db = getPrisma()): Promise<RoadmapViewRecord> {
  return (await createSavedView(actor, roadmapSurfaceFor(surface), surface, input, db)) as RoadmapViewRecord
}

export async function updateRoadmapView(
  actor: RoadmapViewActor, surface: RoadmapViewSurface, id: string, input: unknown, db: Db = getPrisma(), expectedUpdatedAt?: string,
): Promise<RoadmapViewRecord> {
  return (await updateSavedView(actor, roadmapSurfaceFor(surface), surface, id, input, expectedUpdatedAt, db)) as RoadmapViewRecord
}

export async function deleteRoadmapView(actor: RoadmapViewActor, surface: RoadmapViewSurface, id: string, db: Db = getPrisma()): Promise<void> {
  await deleteSavedView(actor, roadmapSurfaceFor(surface), surface, id, db)
}
