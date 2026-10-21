/**
 * Compatibility shim: the access rules now live in lib/saved-views/access.ts and
 * apply to every surface. Kept for one release so the Roadmap call sites and tests
 * keep their imports (ADR "Generic saved views", migration shim).
 */
export {
  canCreateView, canDeleteView, canEditView, canSeeView, canShareOnSurface, canUseSurface,
} from "@/lib/saved-views/access"
export type {
  SavedViewAccessRow as RoadmapViewAccessRow,
  SavedViewActor as RoadmapViewActor,
  SavedViewScope as RoadmapViewSurface,
  SavedViewVisibility as RoadmapViewVisibility,
} from "@/lib/saved-views/access"
