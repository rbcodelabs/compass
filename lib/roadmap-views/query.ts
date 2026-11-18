/**
 * The cross-workspace roadmap read. Takes the viewer's ALREADY-RESOLVED readable
 * workspace ids and never trusts a filter (saved or from the URL) to widen them:
 * `workspaceIds` in a filter can only narrow, so a shared view that names a
 * workspace the viewer can't read contributes nothing from it.
 */
import type { Prisma } from "@prisma/client"
import getPrisma from "@/lib/db"
import { getTasksLinkedTo } from "@/lib/task-links-read"
import { ROADMAP_CARD_INCLUDE, toRoadmapCardData } from "@/lib/roadmap/card-data"
import type { RoadmapCardData } from "@/components/roadmap/roadmap-card"
import type { TaskStatus } from "@/lib/types"
import { resolveEffectiveOptions } from "@/lib/shared-field-options"
import { makeRoadmapFieldKey, type RoadmapViewDisplay, type RoadmapViewFilters } from "@/lib/roadmap-views/schema"
import {
  buildFieldFacets, cellsMatchLabels, toCellValues,
  type FieldCellValue, type FieldDefinitionInput, type RoadmapFieldFacet,
} from "@/lib/roadmap-views/fields"

type Db = ReturnType<typeof getPrisma>

/** Hard cap on items rendered at once; past it the page says so rather than silently dropping rows. */
export const MAX_ROADMAP_ITEMS = 1000

export type CrossWorkspaceRoadmapItem = RoadmapCardData & {
  workspace: { id: string; name: string; slug: string }
  /** Cells for the custom fields the view uses (shown fields + the grouping field), by field key. A missing key means not set, or not defined in this item's workspace. */
  fieldValues: Record<string, FieldCellValue[]>
}

export type RoadmapFacets = {
  workspaces: Array<{ id: string; name: string; slug: string }>
  squads: Array<{ id: string; name: string; color: string | null; workspaceId: string }>
  /** Every ROADMAP_ITEM custom field the viewer can read, merged across workspaces by type + name. */
  fields: RoadmapFieldFacet[]
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
export function buildRoadmapWhere(workspaceIds: readonly string[], filters: RoadmapViewFilters, itemIds?: readonly string[]): Prisma.RoadmapItemWhereInput {
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
    ...(itemIds ? { id: { in: [...itemIds] } } : {}),
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

/** Roadmap-item custom field definitions in the given workspaces, with shared option sets resolved. */
export async function loadFieldDefinitions(workspaceIds: readonly string[], db: Db = getPrisma()): Promise<FieldDefinitionInput[]> {
  if (workspaceIds.length === 0) return []
  const rows = await db.customFieldDefinition.findMany({
    where: { workspaceId: { in: [...workspaceIds] }, objectType: "ROADMAP_ITEM" },
    select: { id: true, workspaceId: true, name: true, fieldType: true, order: true, options: true, sharedOptionSet: { select: { options: true } } },
  })
  return rows.map((r) => ({
    id: r.id, workspaceId: r.workspaceId, name: r.name, fieldType: r.fieldType, order: r.order,
    options: resolveEffectiveOptions({ fieldType: r.fieldType, options: r.options, sharedOptionSet: r.sharedOptionSet }),
  }))
}

export async function loadRoadmapFacets(readableIds: readonly string[], db: Db = getPrisma()): Promise<RoadmapFacets> {
  const [workspaces, squads, definitions] = await Promise.all([
    db.workspace.findMany({ where: { id: { in: [...readableIds] } }, select: { id: true, name: true, slug: true }, orderBy: { name: "asc" } }),
    db.squad.findMany({ where: { workspaceId: { in: [...readableIds] } }, select: { id: true, name: true, color: true, workspaceId: true }, orderBy: { name: "asc" } }),
    loadFieldDefinitions(readableIds, db),
  ])
  return { workspaces, squads, fields: buildFieldFacets(definitions) }
}

/**
 * Ids of the items that satisfy EVERY field filter (ANDed across fields, ORed within
 * one field's labels). Evaluated in application code, like the workspace roadmap's
 * custom-field filter, so it behaves identically on local PostgreSQL and Aurora DSQL.
 * Returns null when there are no field filters (no restriction).
 */
async function matchingItemIds(
  definitions: readonly FieldDefinitionInput[], filters: RoadmapViewFilters["fields"], db: Db,
): Promise<Set<string> | null> {
  if (filters.length === 0) return null
  const matchedPerFilter: Array<Set<string>> = []
  for (const filter of filters) {
    const defs = definitions.filter((d) => makeRoadmapFieldKey(d.fieldType, d.name) === filter.key)
    const byId = new Map(defs.map((d) => [d.id, d]))
    const matched = new Set<string>()
    if (defs.length > 0) {
      const rows = await db.customFieldValue.findMany({ where: { fieldId: { in: defs.map((d) => d.id) } }, select: { fieldId: true, objectId: true, value: true } })
      for (const row of rows) {
        const def = byId.get(row.fieldId)
        if (def && cellsMatchLabels(toCellValues(def, row.value), filter.values)) matched.add(row.objectId)
      }
    }
    matchedPerFilter.push(matched)
  }
  // Intersect: an item must satisfy every field filter.
  const [first, ...rest] = matchedPerFilter
  const ids: string[] = [...first].filter((id: string) => rest.every((set) => set.has(id)))
  return new Set<string>(ids)
}

/** Cells for the shown fields, per item. One query for all shown fields' values across the page. */
async function loadItemFieldValues(
  page: ReadonlyArray<{ id: string; workspaceId: string }>,
  definitions: readonly FieldDefinitionInput[],
  keys: readonly string[],
  db: Db,
): Promise<Map<string, Record<string, FieldCellValue[]>>> {
  const out = new Map<string, Record<string, FieldCellValue[]>>()
  if (keys.length === 0 || page.length === 0) return out
  const wanted = new Set(keys)
  const defs = definitions.filter((d) => wanted.has(makeRoadmapFieldKey(d.fieldType, d.name)))
  if (defs.length === 0) return out
  const byId = new Map(defs.map((d) => [d.id, d]))
  const workspaceOf = new Map(page.map((r) => [r.id, r.workspaceId]))
  const rows = await db.customFieldValue.findMany({
    where: { fieldId: { in: defs.map((d) => d.id) }, objectId: { in: page.map((r) => r.id) } },
    select: { fieldId: true, objectId: true, value: true },
  })
  for (const row of rows) {
    const def = byId.get(row.fieldId)
    // A definition from another workspace cannot apply to this item; ignore a stray row.
    if (!def || workspaceOf.get(row.objectId) !== def.workspaceId) continue
    const cells = toCellValues(def, row.value)
    if (cells.length === 0) continue
    const record = out.get(row.objectId) ?? {}
    record[makeRoadmapFieldKey(def.fieldType, def.name)] = cells
    out.set(row.objectId, record)
  }
  return out
}

export async function loadCrossWorkspaceRoadmap(
  readableIds: readonly string[],
  filters: RoadmapViewFilters,
  display: RoadmapViewDisplay,
  db: Db = getPrisma(),
): Promise<{ items: CrossWorkspaceRoadmapItem[]; truncated: boolean }> {
  const workspaceIds = effectiveWorkspaceIds(readableIds, filters.workspaceIds)
  if (workspaceIds.length === 0) return { items: [], truncated: false }

  const shownKeys = [...new Set([...display.fields, ...(display.groupByField ? [display.groupByField] : [])])]
  const definitions = shownKeys.length > 0 || filters.fields.length > 0 ? await loadFieldDefinitions(workspaceIds, db) : []

  const allowedIds = await matchingItemIds(definitions, filters.fields, db)
  if (allowedIds && allowedIds.size === 0) return { items: [], truncated: false }

  const rows = await db.roadmapItem.findMany({
    where: buildRoadmapWhere(workspaceIds, filters, allowedIds ? [...allowedIds] : undefined),
    orderBy: buildRoadmapOrderBy(display.sort),
    include: { ...ROADMAP_CARD_INCLUDE, workspace: { select: { id: true, name: true, slug: true } } },
    take: MAX_ROADMAP_ITEMS + 1,
  })
  const truncated = rows.length > MAX_ROADMAP_ITEMS
  const page = truncated ? rows.slice(0, MAX_ROADMAP_ITEMS) : rows

  const taskLinks = page.length === 0 ? [] : await getTasksLinkedTo(db, { workspaceIds, linkedType: "ROADMAP_ITEM", linkedIds: page.map((r) => r.id) })
  const statusesByItem = new Map<string, TaskStatus[]>()
  for (const link of taskLinks) {
    const list = statusesByItem.get(link.linkedId) ?? []
    list.push(link.task.status as TaskStatus)
    statusesByItem.set(link.linkedId, list)
  }

  const fieldValuesByItem = await loadItemFieldValues(page, definitions, shownKeys, db)

  let items = page.map((row): CrossWorkspaceRoadmapItem => ({
    ...toRoadmapCardData(row, statusesByItem.get(row.id) ?? []),
    workspace: row.workspace,
    fieldValues: fieldValuesByItem.get(row.id) ?? {},
  }))
  if (filters.deliveryStatuses.length) {
    const wanted = new Set<string>(filters.deliveryStatuses)
    items = items.filter((item) => wanted.has(item.deliveryStatus))
  }
  return { items, truncated }
}
