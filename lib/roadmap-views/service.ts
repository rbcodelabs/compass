/**
 * Saved roadmap view persistence: resolving who the caller is on a surface, and
 * CRUD with the rules from access.ts enforced on every call. Server-only (no
 * session access here: callers pass the user id, so this stays testable and the
 * session lookup lives in exactly one place, the server actions/pages).
 */
import getPrisma from "@/lib/db"
import { getUserWorkspaces } from "@/lib/workspace"
import { isOrgAdminRole, normalizeWorkspaceRole } from "@/lib/roles"
import {
  canCreateView, canDeleteView, canEditView, canSeeView, canUseSurface,
  type RoadmapViewActor, type RoadmapViewSurface, type RoadmapViewVisibility,
} from "@/lib/roadmap-views/access"
import { RoadmapViewError } from "@/lib/roadmap-views/errors"
import {
  parseStoredDisplay, parseStoredFilters, roadmapViewInputSchema,
  type RoadmapViewDisplay, type RoadmapViewFilters, type RoadmapViewInput,
} from "@/lib/roadmap-views/schema"

type Db = ReturnType<typeof getPrisma>

/** A generous cap per owner per surface: it bounds row growth, not everyday use. */
export const MAX_VIEWS_PER_OWNER_PER_SURFACE = 50

export type RoadmapViewRecord = {
  id: string
  name: string
  visibility: RoadmapViewVisibility
  /** null = org-level view. */
  workspaceId: string | null
  ownerId: string
  isOwner: boolean
  /** Owner, or a surface admin on a SHARED view — mirrors canDeleteView so the UI only offers Delete when the server will accept it. */
  canDelete: boolean
  filters: RoadmapViewFilters
  display: RoadmapViewDisplay
  updatedAt: string
}

type Row = {
  id: string; organizationId: string; workspaceId: string | null; ownerId: string; name: string
  visibility: string; filters: unknown; display: unknown; updatedAt: Date
}

function toRecord(row: Row, actor: RoadmapViewActor): RoadmapViewRecord {
  const userId = actor.userId
  return {
    id: row.id,
    name: row.name,
    visibility: row.visibility === "SHARED" ? "SHARED" : "PERSONAL",
    workspaceId: row.workspaceId,
    ownerId: row.ownerId,
    isOwner: row.ownerId === userId,
    canDelete: canDeleteView(actor, row),
    // Re-validated on read: a stored document that no longer parses degrades to the default view.
    filters: parseStoredFilters(row.filters),
    display: parseStoredDisplay(row.display),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * Resolves the caller's standing in one org, or null when they can reach nothing
 * there (callers treat that as 404 so an org's existence is not revealed).
 *
 * Workspace access comes from `getUserWorkspaces` -- the same resolver the sidebar
 * uses, including the org-wide read-only fallback -- so this surface can never show
 * a workspace the sidebar would not list.
 */
export async function resolveRoadmapViewActor(userId: string, orgSlug: string, db: Db = getPrisma()): Promise<RoadmapViewActor | null> {
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

/** Views the actor can see on a surface: their own, plus everything shared there. Shared first, then by name. */
export async function listRoadmapViews(actor: RoadmapViewActor, surface: RoadmapViewSurface, db: Db = getPrisma()): Promise<RoadmapViewRecord[]> {
  if (!canUseSurface(actor, surface)) return []
  const rows = await db.roadmapView.findMany({
    where: {
      organizationId: actor.organizationId,
      workspaceId: surface,
      OR: [{ ownerId: actor.userId }, { visibility: "SHARED" }],
    },
    orderBy: [{ name: "asc" }],
    take: 500,
  })
  return rows
    .filter((row) => canSeeView(actor, row))
    .map((row) => toRecord(row, actor))
    .sort((a, b) => Number(a.isOwner) - Number(b.isOwner) || a.name.localeCompare(b.name))
}

/** One view by id, only if the actor can see it on the expected surface. A view on another surface is "not found". */
export async function getRoadmapView(actor: RoadmapViewActor, surface: RoadmapViewSurface, id: string, db: Db = getPrisma()): Promise<RoadmapViewRecord | null> {
  const row = await db.roadmapView.findFirst({ where: { id, organizationId: actor.organizationId, workspaceId: surface } })
  if (!row || !canSeeView(actor, row)) return null
  return toRecord(row, actor)
}

function parseInput(input: unknown): RoadmapViewInput {
  const result = roadmapViewInputSchema.safeParse(input)
  if (!result.success) throw new RoadmapViewError("INVALID", result.error.issues[0]?.message ?? "Invalid view")
  return result.data
}

export async function createRoadmapView(actor: RoadmapViewActor, surface: RoadmapViewSurface, input: unknown, db: Db = getPrisma()): Promise<RoadmapViewRecord> {
  const data = parseInput(input)
  if (!canUseSurface(actor, surface)) throw new RoadmapViewError("NOT_FOUND", "Roadmap not found")
  if (!canCreateView(actor, surface, data.visibility)) {
    throw new RoadmapViewError("FORBIDDEN", "You can't share views on this roadmap")
  }
  const existing = await db.roadmapView.count({ where: { organizationId: actor.organizationId, workspaceId: surface, ownerId: actor.userId } })
  if (existing >= MAX_VIEWS_PER_OWNER_PER_SURFACE) {
    throw new RoadmapViewError("LIMIT", `You can save up to ${MAX_VIEWS_PER_OWNER_PER_SURFACE} views here. Delete one first.`)
  }
  const now = new Date()
  const row = await db.roadmapView.create({
    data: {
      organizationId: actor.organizationId,
      workspaceId: surface,
      ownerId: actor.userId,
      name: data.name,
      visibility: data.visibility,
      filters: data.filters,
      display: data.display,
      createdAt: now,
      updatedAt: now,
    },
  })
  return toRecord(row, actor)
}

export async function updateRoadmapView(actor: RoadmapViewActor, surface: RoadmapViewSurface, id: string, input: unknown, db: Db = getPrisma()): Promise<RoadmapViewRecord> {
  const data = parseInput(input)
  const row = await db.roadmapView.findFirst({ where: { id, organizationId: actor.organizationId, workspaceId: surface } })
  if (!row || !canSeeView(actor, row)) throw new RoadmapViewError("NOT_FOUND", "View not found")
  if (!canEditView(actor, row, data.visibility)) throw new RoadmapViewError("FORBIDDEN", "Only the owner can change this view")
  // Scoped to the owner in the write itself, not just the check above: a concurrent
  // ownership change can't turn this into an edit of someone else's view.
  const result = await db.roadmapView.updateMany({
    where: { id, organizationId: actor.organizationId, ownerId: actor.userId },
    data: { name: data.name, visibility: data.visibility, filters: data.filters, display: data.display, updatedAt: new Date() },
  })
  if (result.count === 0) throw new RoadmapViewError("NOT_FOUND", "View not found")
  const fresh = await db.roadmapView.findFirst({ where: { id, organizationId: actor.organizationId } })
  if (!fresh) throw new RoadmapViewError("NOT_FOUND", "View not found")
  return toRecord(fresh, actor)
}

export async function deleteRoadmapView(actor: RoadmapViewActor, surface: RoadmapViewSurface, id: string, db: Db = getPrisma()): Promise<void> {
  const row = await db.roadmapView.findFirst({ where: { id, organizationId: actor.organizationId, workspaceId: surface } })
  if (!row || !canSeeView(actor, row)) throw new RoadmapViewError("NOT_FOUND", "View not found")
  if (!canDeleteView(actor, row)) throw new RoadmapViewError("FORBIDDEN", "You can't delete this view")
  await db.roadmapView.deleteMany({ where: { id, organizationId: actor.organizationId } })
}
