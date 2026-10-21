/**
 * Who may see, create, change and delete a saved view. The "scope" is a workspace id, or null for the org level. Pure functions over
 * an already-resolved {@link SavedViewActor}, so every rule is unit-testable
 * without a database and the service layer has exactly one place to enforce them.
 *
 * Two independent questions are kept apart on purpose:
 *   1. May the actor use the SURFACE (the org roadmap, or one workspace's roadmap)?
 *      That mirrors workspace read access exactly: a WorkspaceMember row, or the
 *      org-wide read-only fallback (`getUserWorkspaces`).
 *   2. May the actor use THIS VIEW on it? Personal views: owner only. Shared views:
 *      everyone who can use the surface.
 *
 * Sharing a view never widens data access. A shared view carries only a filter
 * document; the roadmap items behind it are re-scoped to the viewer's own readable
 * workspaces at query time (see query.ts), so a viewer who cannot read a workspace
 * named in a shared view simply sees nothing from it.
 */

export type SavedViewVisibility = "PERSONAL" | "SHARED"

/** null = the org-level cross-workspace roadmap; a workspace id = that workspace's roadmap. */
export type SavedViewScope = string | null

export type SavedViewActor = {
  userId: string
  organizationId: string
  /** OWNER or ADMIN of the organization. */
  isOrgAdmin: boolean
  /** Every workspace in this org the actor can read, with how they got in. */
  workspaces: ReadonlyArray<{ id: string; isReadOnly: boolean; isAdmin: boolean }>
}

export type SavedViewAccessRow = {
  organizationId: string
  workspaceId: string | null
  ownerId: string
  visibility: string
}

export function canUseSurface(actor: SavedViewActor, surface: SavedViewScope): boolean {
  if (surface === null) return actor.workspaces.length > 0
  return actor.workspaces.some((w) => w.id === surface)
}

/**
 * Sharing writes a row other people will see, so it needs a real (non-read-only)
 * seat on the surface: a read-only org member may keep personal views but not
 * publish them to colleagues. Org admins may always share.
 */
export function canShareOnSurface(actor: SavedViewActor, surface: SavedViewScope): boolean {
  if (!canUseSurface(actor, surface)) return false
  if (actor.isOrgAdmin) return true
  if (surface === null) return actor.workspaces.some((w) => !w.isReadOnly)
  return actor.workspaces.some((w) => w.id === surface && !w.isReadOnly)
}

function isSurfaceAdmin(actor: SavedViewActor, surface: SavedViewScope): boolean {
  if (actor.isOrgAdmin) return true
  if (surface === null) return false
  return actor.workspaces.some((w) => w.id === surface && w.isAdmin)
}

export function canSeeView(actor: SavedViewActor, view: SavedViewAccessRow): boolean {
  if (view.organizationId !== actor.organizationId) return false
  if (!canUseSurface(actor, view.workspaceId)) return false
  return view.ownerId === actor.userId || view.visibility === "SHARED"
}

/** Create a view with the requested visibility. */
export function canCreateView(actor: SavedViewActor, surface: SavedViewScope, visibility: SavedViewVisibility): boolean {
  if (!canUseSurface(actor, surface)) return false
  return visibility === "SHARED" ? canShareOnSurface(actor, surface) : true
}

/** Change a view's name, filters, display or visibility. Only the owner edits a view's content. */
export function canEditView(actor: SavedViewActor, view: SavedViewAccessRow, nextVisibility: SavedViewVisibility): boolean {
  if (!canSeeView(actor, view) || view.ownerId !== actor.userId) return false
  // Staying/going PERSONAL is always allowed; (re)publishing needs a share seat.
  return nextVisibility === "SHARED" ? canShareOnSurface(actor, view.workspaceId) : true
}

/** The owner can always delete their own view; surface admins can remove a SHARED view (e.g. its owner left). */
export function canDeleteView(actor: SavedViewActor, view: SavedViewAccessRow): boolean {
  if (!canSeeView(actor, view)) return false
  if (view.ownerId === actor.userId) return true
  return view.visibility === "SHARED" && isSurfaceAdmin(actor, view.workspaceId)
}
