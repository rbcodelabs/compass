/**
 * Saved view persistence for every surface (Opportunities board, Solutions board,
 * both roadmaps): resolving who the caller is, and CRUD with the rules from
 * access.ts enforced on every call. Server-only (no session access here: callers
 * pass the user id, so this stays testable and the session lookup lives in exactly
 * one place, the server actions/pages).
 *
 * A row's surface is `surface`, or -- for legacy rows with NULL -- derived from its
 * workspace id (see surfaces.ts). Writes always stamp `surface`.
 */
import getPrisma from "@/lib/db"
import { getUserWorkspaces } from "@/lib/workspace"
import { isOrgAdminRole, normalizeWorkspaceRole } from "@/lib/roles"
import {
  canCreateView, canDeleteView, canEditView, canSeeView, canUseSurface,
  type SavedViewActor, type SavedViewVisibility,
} from "@/lib/saved-views/access"
import { SavedViewError } from "@/lib/saved-views/errors"
import {
  parseStoredDisplayFor, parseStoredFiltersFor, savedViewInputSchemaFor, type SavedViewInput,
} from "@/lib/saved-views/schema"
import { SURFACES, isConsistentScope, resolveRowSurface, type SavedViewSurface } from "@/lib/saved-views/surfaces"

type Db = ReturnType<typeof getPrisma>

/** A generous cap per owner per surface: it bounds row growth, not everyday use. */
export const MAX_VIEWS_PER_OWNER_PER_SURFACE = 50

export type SavedViewRecord<F = unknown, D = unknown> = {
  id: string
  name: string
  visibility: SavedViewVisibility
  surface: SavedViewSurface
  /** null = org-level view. */
  workspaceId: string | null
  ownerId: string
  isOwner: boolean
  /** Owner, or a surface admin on a SHARED view — mirrors canDeleteView so the UI only offers Delete when the server will accept it. */
  canDelete: boolean
  filters: F
  display: D
  updatedAt: string
}

type Row = {
  id: string; organizationId: string; workspaceId: string | null; ownerId: string; name: string
  visibility: string; surface: string | null; filters: unknown; display: unknown; updatedAt: Date
}

function toRecord(row: Row, actor: SavedViewActor): SavedViewRecord {
  const surface = resolveRowSurface(row)
  return {
    id: row.id,
    name: row.name,
    visibility: row.visibility === "SHARED" ? "SHARED" : "PERSONAL",
    surface,
    workspaceId: row.workspaceId,
    ownerId: row.ownerId,
    isOwner: row.ownerId === actor.userId,
    canDelete: canDeleteView(actor, row),
    // Re-validated on read: a stored document that no longer parses degrades to the default view.
    filters: parseStoredFiltersFor(surface, row.filters),
    display: parseStoredDisplayFor(surface, row.display),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * Narrows a query to one surface. The roadmap surfaces also match legacy NULL rows: the
 * workspace id already in the query is what tells ROADMAP_ORG from ROADMAP_WORKSPACE.
 * Board surfaces never existed before migration 100, so they match only their own stamp.
 */
function surfaceClause(surface: SavedViewSurface) {
  return surface === "ROADMAP_ORG" || surface === "ROADMAP_WORKSPACE" ? { OR: [{ surface }, { surface: null }] } : { surface }
}

function scopeWhere(actor: SavedViewActor, surface: SavedViewSurface, workspaceId: string | null) {
  return { organizationId: actor.organizationId, workspaceId, AND: [surfaceClause(surface)] }
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * Resolves the caller's standing in one org, or null when they can reach nothing
 * there (callers treat that as 404 so an org's existence is not revealed).
 *
 * Workspace access comes from `getUserWorkspaces` -- the same resolver the sidebar
 * uses, including the org-wide read-only fallback -- so this surface can never show
 * a workspace the sidebar would not list.
 */
export async function resolveSavedViewActor(userId: string, orgSlug: string, db: Db = getPrisma()): Promise<SavedViewActor | null> {
  const reachable = (await getUserWorkspaces(userId)).filter((w) => w.orgSlug === orgSlug)
  if (reachable.length === 0) return null

  const org = await db.organization.findUnique({ where: { slug: orgSlug }, select: { id: true } })
  if (!org) return null

  const [orgMember, workspaceMembers] = await Promise.all([
    db.organizationMember.findFirst({ where: { organizationId: org.id, userId }, select: { role: true } }),
    db.workspaceMember.findMany({
      where: { userId, workspaceId: { in: reachable.map((w) => w.id) } },
      select: { workspaceId: true, role: true },
    }),
  ])
  const isOrgAdmin = isOrgAdminRole(orgMember?.role)
  const roleByWorkspace = new Map(workspaceMembers.map((m) => [m.workspaceId, normalizeWorkspaceRole(m.role)]))

  return {
    userId,
    organizationId: org.id,
    isOrgAdmin,
    workspaces: reachable.map((w) => ({
      id: w.id,
      isReadOnly: w.isReadOnly,
      isAdmin: roleByWorkspace.get(w.id) === "ADMIN",
    })),
  }
}

/** Views the actor can see on a surface: their own, plus everything shared there. Shared-by-others first, then by name. */
export async function listSavedViews(actor: SavedViewActor, surface: SavedViewSurface, workspaceId: string | null, db: Db = getPrisma()): Promise<SavedViewRecord[]> {
  if (!isConsistentScope(surface, workspaceId) || !canUseSurface(actor, workspaceId)) return []
  const base = scopeWhere(actor, surface, workspaceId)
  const rows = await db.savedView.findMany({
    where: { ...base, AND: [...base.AND, { OR: [{ ownerId: actor.userId }, { visibility: "SHARED" }] }] },
    orderBy: [{ name: "asc" }],
    take: 500,
  })
  return rows
    .filter((row) => canSeeView(actor, row))
    .map((row) => toRecord(row, actor))
    .sort((a, b) => Number(a.isOwner) - Number(b.isOwner) || a.name.localeCompare(b.name))
}

/** One view by id, only if the actor can see it on the expected surface. A view on another surface is "not found". */
export async function getSavedView(actor: SavedViewActor, surface: SavedViewSurface, workspaceId: string | null, id: string, db: Db = getPrisma()): Promise<SavedViewRecord | null> {
  if (!isConsistentScope(surface, workspaceId)) return null
  const row = await db.savedView.findFirst({ where: { id, ...scopeWhere(actor, surface, workspaceId) } })
  if (!row || !canSeeView(actor, row)) return null
  return toRecord(row, actor)
}

function parseInput(surface: SavedViewSurface, input: unknown): SavedViewInput {
  const result = savedViewInputSchemaFor(surface).safeParse(input)
  if (!result.success) throw new SavedViewError("INVALID", result.error.issues[0]?.message ?? "Invalid view")
  return result.data
}

function assertScope(surface: SavedViewSurface, workspaceId: string | null) {
  if (!isConsistentScope(surface, workspaceId)) throw new SavedViewError("INVALID", "Invalid view location")
}

function assertSharingAllowed(surface: SavedViewSurface, visibility: SavedViewVisibility) {
  if (visibility === "SHARED" && !SURFACES[surface].sharing) {
    throw new SavedViewError("FORBIDDEN", `Views can't be shared on this ${SURFACES[surface].label}`)
  }
}

async function assertNameAvailable(
  actor: SavedViewActor, surface: SavedViewSurface, workspaceId: string | null, name: string, excludeId: string | null, db: Db,
) {
  if (!SURFACES[surface].uniqueNames) return
  const base = scopeWhere(actor, surface, workspaceId)
  const clash = await db.savedView.count({
    where: { ...base, ownerId: actor.userId, name, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
  })
  if (clash > 0) throw new SavedViewError("INVALID", "You already have a view with that name")
}

export async function createSavedView(
  actor: SavedViewActor, surface: SavedViewSurface, workspaceId: string | null, input: unknown, db: Db = getPrisma(),
): Promise<SavedViewRecord> {
  const data = parseInput(surface, input)
  assertScope(surface, workspaceId)
  const { label } = SURFACES[surface]
  if (!canUseSurface(actor, workspaceId)) throw new SavedViewError("NOT_FOUND", `${capitalized(label)} not found`)
  assertSharingAllowed(surface, data.visibility)
  if (!canCreateView(actor, workspaceId, data.visibility)) {
    throw new SavedViewError("FORBIDDEN", `You can't share views on this ${label}`)
  }
  const existing = await db.savedView.count({ where: { ...scopeWhere(actor, surface, workspaceId), ownerId: actor.userId } })
  if (existing >= MAX_VIEWS_PER_OWNER_PER_SURFACE) {
    throw new SavedViewError("LIMIT", `You can save up to ${MAX_VIEWS_PER_OWNER_PER_SURFACE} views here. Delete one first.`)
  }
  await assertNameAvailable(actor, surface, workspaceId, data.name, null, db)
  const now = new Date()
  const row = await db.savedView.create({
    data: {
      organizationId: actor.organizationId,
      workspaceId,
      ownerId: actor.userId,
      surface,
      name: data.name,
      visibility: data.visibility,
      filters: data.filters as never,
      display: data.display as never,
      createdAt: now,
      updatedAt: now,
    },
  })
  return toRecord(row, actor)
}

/**
 * @param expectedUpdatedAt the `updatedAt` the caller last saw. When given, a mismatch fails with CONFLICT instead of
 *   silently overwriting a save made elsewhere (two tabs). The write itself is conditional on it, so a save landing
 *   between the check and the write also conflicts.
 */
export async function updateSavedView(
  actor: SavedViewActor, surface: SavedViewSurface, workspaceId: string | null, id: string, input: unknown,
  expectedUpdatedAt?: string, db: Db = getPrisma(),
): Promise<SavedViewRecord> {
  const data = parseInput(surface, input)
  assertScope(surface, workspaceId)
  const row = await db.savedView.findFirst({ where: { id, ...scopeWhere(actor, surface, workspaceId) } })
  if (!row || !canSeeView(actor, row)) throw new SavedViewError("NOT_FOUND", "View not found")
  if (!canEditView(actor, row, data.visibility)) throw new SavedViewError("FORBIDDEN", "Only the owner can change this view")
  assertSharingAllowed(surface, data.visibility)
  if (expectedUpdatedAt !== undefined && row.updatedAt.toISOString() !== expectedUpdatedAt) {
    throw new SavedViewError("CONFLICT", "This view was changed elsewhere. Reload to see the latest version.")
  }
  await assertNameAvailable(actor, surface, workspaceId, data.name, id, db)
  // Scoped to the owner in the write itself, not just the check above: a concurrent
  // ownership change can't turn this into an edit of someone else's view.
  const result = await db.savedView.updateMany({
    where: {
      id, organizationId: actor.organizationId, ownerId: actor.userId,
      ...(expectedUpdatedAt !== undefined ? { updatedAt: row.updatedAt } : {}),
    },
    data: {
      name: data.name, visibility: data.visibility, surface,
      filters: data.filters as never, display: data.display as never, updatedAt: new Date(),
    },
  })
  if (result.count === 0) {
    throw expectedUpdatedAt !== undefined
      ? new SavedViewError("CONFLICT", "This view was changed elsewhere. Reload to see the latest version.")
      : new SavedViewError("NOT_FOUND", "View not found")
  }
  const fresh = await db.savedView.findFirst({ where: { id, organizationId: actor.organizationId } })
  if (!fresh) throw new SavedViewError("NOT_FOUND", "View not found")
  return toRecord(fresh, actor)
}

export async function deleteSavedView(
  actor: SavedViewActor, surface: SavedViewSurface, workspaceId: string | null, id: string, db: Db = getPrisma(),
): Promise<void> {
  assertScope(surface, workspaceId)
  const row = await db.savedView.findFirst({ where: { id, ...scopeWhere(actor, surface, workspaceId) } })
  if (!row || !canSeeView(actor, row)) throw new SavedViewError("NOT_FOUND", "View not found")
  if (!canDeleteView(actor, row)) throw new SavedViewError("FORBIDDEN", "You can't delete this view")
  await db.savedView.deleteMany({ where: { id, organizationId: actor.organizationId } })
}
