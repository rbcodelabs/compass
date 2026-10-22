/**
 * The surfaces a saved view can belong to, and the per-surface rules that are not
 * about the stored document (see schema.ts for that). Pure, so server actions,
 * the service and (later) the client menu share one registry.
 */

export const SAVED_VIEW_SURFACES = [
  "OPPORTUNITIES_BOARD",
  "SOLUTIONS_BOARD",
  "ROADMAP_WORKSPACE",
  "ROADMAP_ORG",
] as const

export type SavedViewSurface = (typeof SAVED_VIEW_SURFACES)[number]

export function isSavedViewSurface(value: unknown): value is SavedViewSurface {
  return typeof value === "string" && (SAVED_VIEW_SURFACES as readonly string[]).includes(value)
}

export type SurfaceConfig = {
  /** ROADMAP_ORG is the only org-level surface: it requires workspaceId null, every other one requires a workspace. */
  workspaceScoped: boolean
  /** When false the service rejects SHARED views on this surface. Turning it on later needs no migration. */
  sharing: boolean
  /** Names must be unique per owner, surface and workspace. Roadmap keeps its historical behaviour (duplicates allowed). */
  uniqueNames: boolean
  /** Human label used in error messages. */
  label: string
}

export const SURFACES: Readonly<Record<SavedViewSurface, SurfaceConfig>> = {
  OPPORTUNITIES_BOARD: { workspaceScoped: true, sharing: false, uniqueNames: true, label: "opportunities board" },
  SOLUTIONS_BOARD: { workspaceScoped: true, sharing: false, uniqueNames: true, label: "solutions board" },
  ROADMAP_WORKSPACE: { workspaceScoped: true, sharing: true, uniqueNames: false, label: "roadmap" },
  ROADMAP_ORG: { workspaceScoped: false, sharing: true, uniqueNames: false, label: "roadmap" },
}

/**
 * The surface a row written before migration 100 belongs to. Only the two roadmap
 * surfaces existed then, and the workspace id told them apart.
 */
export function legacySurfaceFor(workspaceId: string | null): SavedViewSurface {
  return workspaceId === null ? "ROADMAP_ORG" : "ROADMAP_WORKSPACE"
}

/** Reads a stored row's surface; NULL (legacy, or written by old code mid-rollout) is derived from the workspace id. */
export function resolveRowSurface(row: { surface: string | null; workspaceId: string | null }): SavedViewSurface {
  return isSavedViewSurface(row.surface) ? row.surface : legacySurfaceFor(row.workspaceId)
}

/** The surface for the roadmap, given the existing `workspaceId | null` convention. */
export function roadmapSurfaceFor(workspaceId: string | null): SavedViewSurface {
  return legacySurfaceFor(workspaceId)
}

/** Whether (surface, workspaceId) is a consistent pair. */
export function isConsistentScope(surface: SavedViewSurface, workspaceId: string | null): boolean {
  return SURFACES[surface].workspaceScoped ? workspaceId !== null : workspaceId === null
}
