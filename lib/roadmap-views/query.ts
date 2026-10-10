/**
 * The cross-workspace roadmap read. Takes the viewer's ALREADY-RESOLVED readable
 * workspace ids and never trusts a filter (saved or from the URL) to widen them:
 * `workspaceIds` in a filter can only narrow, so a shared view that names a
 * workspace the viewer can't read contributes nothing from it.
 */
import type { Prisma } from "@prisma/client"
import getPrisma from "@/lib/db"
import { ROADMAP_CARD_INCLUDE, toRoadmapCardData } from "@/lib/roadmap/card-data"
import type { RoadmapCardData } from "@/components/roadmap/roadmap-card"
import type { TaskStatus } from "@/lib/types"
import type { RoadmapViewDisplay, RoadmapViewFilters } from "@/lib/roadmap-views/schema"

type Db = ReturnType<typeof getPrisma>

/** Hard cap on items rendered at once; past it the page says so rather than silently dropping rows. */
export const MAX_ROADMAP_ITEMS = 1000

export type CrossWorkspaceRoadmapItem = RoadmapCardData & {
  workspace: { id: string; name: string; slug: string }
}

export type RoadmapFacets = {
  workspaces: Array<{ id: string; name: string; slug: string }>
  squads: Array<{ id: string; name: string; color: string | null; workspaceId: string }>
}

/** Intersection of the filter's workspaces with what the viewer can read. Empty filter = everything readable. */
export function effectiveWorkspaceIds(readableIds: readonly string[], filterIds: readonly string[]): string[] {
  if (filterIds.length === 0) return [...readableIds]
  const wanted = new Set(filterIds)
  return readableIds.filter((id) => wanted.has(id))
}

function startOfDay(day: string) { return new Date(`${day}T00:00:00.000Z`) }
function endOfDay(day: string) { return new Date(`${day}T23:59:59.999Z`) }

/**
 * Prisma `where` for the DB-expressible filters (delivery status is derived from
 * task links, so it is applied in memory afterwards). Date filter = overlap of the
 * item's [start, end] with [dateFrom, dateTo]; a one-sided item (only a start or
 * only an end) counts as that single day; an undated item never matches a date filter.
 */
export function buildRoadmapWhere(workspaceIds: readonly string[], filters: RoadmapViewFilters): Prisma.RoadmapItemWhereInput {
  const and: Prisma.RoadmapItemWhereInput[] = []
  if (filters.dateFrom) {
    const from = startOfDay(filters.dateFrom)
    and.push({ OR: [{ endDate: { gte: from } }, { endDate: null, startDate: { gte: from } }] })
  }
  if (filters.dateTo) {
    const to = endOfDay(filters.dateTo)
    and.push({ OR: [{ startDate: { lte: to } }, { startDate: null, endDate: { lte: to } }] })
  }
  return {
    workspaceId: { in: [...workspaceIds] },
    status: "ACTIVE",
    ...(filters.horizons.length ? { horizon: { in: filters.horizons } } : {}),
    ...(filters.squadIds.length ? { squadId: { in: filters.squadIds } } : {}),
    ...(filters.keyResult ? { keyResultId: filters.keyResult === "linked" ? { not: null } : null } : {}),
    ...(filters.solution ? { solutionId: filters.solution === "linked" ? { not: null } : null } : {}),
    ...(and.length ? { AND: and } : {}),
  }
}

export function buildRoadmapOrderBy(sort: RoadmapViewDisplay["sort"]): Prisma.RoadmapItemOrderByWithRelationInput[] {
  switch (sort) {
    case "startDate": return [{ startDate: { sort: "asc", nulls: "last" } }, { title: "asc" }]
    case "endDate": return [{ endDate: { sort: "asc", nulls: "last" } }, { title: "asc" }]
    case "title": return [{ title: "asc" }]
    case "updated": return [{ updatedAt: "desc" }]
    default: return [{ horizon: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }]
  }
}

export async function loadRoadmapFacets(readableIds: readonly string[], db: Db = getPrisma()): Promise<RoadmapFacets> {
  const [workspaces, squads] = await Promise.all([
    db.workspace.findMany({ where: { id: { in: [...readableIds] } }, select: { id: true, name: true, slug: true }, orderBy: { name: "asc" } }),
    db.squad.findMany({ where: { workspaceId: { in: [...readableIds] } }, select: { id: true, name: true, color: true, workspaceId: true }, orderBy: { name: "asc" } }),
  ])
  return { workspaces, squads }
}

export async function loadCrossWorkspaceRoadmap(
  readableIds: readonly string[],
  filters: RoadmapViewFilters,
  display: RoadmapViewDisplay,
  db: Db = getPrisma(),
): Promise<{ items: CrossWorkspaceRoadmapItem[]; truncated: boolean }> {
  const workspaceIds = effectiveWorkspaceIds(readableIds, filters.workspaceIds)
  if (workspaceIds.length === 0) return { items: [], truncated: false }

  const rows = await db.roadmapItem.findMany({
    where: buildRoadmapWhere(workspaceIds, filters),
    orderBy: buildRoadmapOrderBy(display.sort),
    include: { ...ROADMAP_CARD_INCLUDE, workspace: { select: { id: true, name: true, slug: true } } },
    take: MAX_ROADMAP_ITEMS + 1,
  })
  const truncated = rows.length > MAX_ROADMAP_ITEMS
  const page = truncated ? rows.slice(0, MAX_ROADMAP_ITEMS) : rows

  const taskLinks = page.length === 0 ? [] : await db.taskLink.findMany({
    where: { linkedType: "ROADMAP_ITEM", linkedId: { in: page.map((r) => r.id) }, task: { workspaceId: { in: workspaceIds } } },
    select: { linkedId: true, task: { select: { status: true } } },
  })
  const statusesByItem = new Map<string, TaskStatus[]>()
  for (const link of taskLinks) {
    const list = statusesByItem.get(link.linkedId) ?? []
    list.push(link.task.status as TaskStatus)
    statusesByItem.set(link.linkedId, list)
  }

  let items = page.map((row): CrossWorkspaceRoadmapItem => ({
    ...toRoadmapCardData(row, statusesByItem.get(row.id) ?? []),
    workspace: row.workspace,
  }))
  if (filters.deliveryStatuses.length) {
    const wanted = new Set<string>(filters.deliveryStatuses)
    items = items.filter((item) => wanted.has(item.deliveryStatus))
  }
  return { items, truncated }
}
