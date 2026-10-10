/**
 * Pure presentation helpers for the cross-workspace roadmap: splitting the item
 * list into groups (board columns / timeline rows) and placing dated items on a
 * month axis. No React, no database, so both layouts and the tests share them.
 */
import { HORIZON_META } from "@/lib/roadmap"
import { ROADMAP_HORIZONS, type RoadmapViewDisplay, type RoadmapViewFilters } from "@/lib/roadmap-views/schema"
import type { CrossWorkspaceRoadmapItem } from "@/lib/roadmap-views/query"

export type RoadmapGroup = {
  key: string
  label: string
  /** Hex colour for the group dot, when the grouping has one (horizon, squad). */
  color?: string
  items: CrossWorkspaceRoadmapItem[]
}

/** Horizons always shown as board columns, even when empty. The others appear only when they hold items or are filtered on. */
const ALWAYS_SHOWN_HORIZONS = new Set<string>(["NOW", "NEXT", "LATER"])

export function groupRoadmapItems(
  items: readonly CrossWorkspaceRoadmapItem[],
  groupBy: RoadmapViewDisplay["groupBy"],
  filters: Pick<RoadmapViewFilters, "horizons">,
  workspaceOrder: ReadonlyArray<{ id: string; name: string }> = [],
): RoadmapGroup[] {
  if (groupBy === "none") return [{ key: "all", label: "All items", items: [...items] }]

  if (groupBy === "horizon") {
    const wanted = new Set<string>(filters.horizons)
    return ROADMAP_HORIZONS.flatMap((horizon) => {
      const inGroup = items.filter((item) => item.horizon === horizon)
      const show = wanted.size > 0 ? wanted.has(horizon) : ALWAYS_SHOWN_HORIZONS.has(horizon) || inGroup.length > 0
      return show ? [{ key: horizon, label: HORIZON_META[horizon].label, color: HORIZON_META[horizon].color, items: inGroup }] : []
    })
  }

  if (groupBy === "workspace") {
    const byId = new Map<string, RoadmapGroup>()
    for (const item of items) {
      const group = byId.get(item.workspace.id) ?? { key: item.workspace.id, label: item.workspace.name, items: [] }
      group.items.push(item)
      byId.set(item.workspace.id, group)
    }
    const order = new Map(workspaceOrder.map((w, i) => [w.id, i]))
    return [...byId.values()].sort((a, b) => (order.get(a.key) ?? 1e9) - (order.get(b.key) ?? 1e9) || a.label.localeCompare(b.label))
  }

  // squad: squads are per-workspace, so two workspaces can both have "Growth". The workspace name disambiguates.
  const bySquad = new Map<string, RoadmapGroup>()
  const unassigned: RoadmapGroup = { key: "__none__", label: "No squad", items: [] }
  for (const item of items) {
    if (!item.squad) { unassigned.items.push(item); continue }
    const group = bySquad.get(item.squad.id) ?? {
      key: item.squad.id,
      label: `${item.squad.name} · ${item.workspace.name}`,
      color: item.squad.color,
      items: [],
    }
    group.items.push(item)
    bySquad.set(item.squad.id, group)
  }
  const groups = [...bySquad.values()].sort((a, b) => a.label.localeCompare(b.label))
  return unassigned.items.length ? [...groups, unassigned] : groups
}

/* ------------------------------------------------------------------ timeline */

export type TimelineMonth = { key: string; label: string; leftPct: number; widthPct: number }

export type TimelineLayout = {
  months: TimelineMonth[]
  /** Percent offsets for a dated item; null when it has no usable date. */
  place: (item: Pick<CrossWorkspaceRoadmapItem, "startDate" | "endDate">) => { leftPct: number; widthPct: number } | null
}

const MONTH_FMT = new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit", timeZone: "UTC" })

function itemSpan(item: Pick<CrossWorkspaceRoadmapItem, "startDate" | "endDate">): { start: number; end: number } | null {
  const start = item.startDate ? Date.parse(item.startDate) : NaN
  const end = item.endDate ? Date.parse(item.endDate) : NaN
  if (Number.isNaN(start) && Number.isNaN(end)) return null
  // A one-sided item is a single day; a reversed range is normalised rather than drawn backwards.
  const a = Number.isNaN(start) ? end : start
  const b = Number.isNaN(end) ? start : end
  return { start: Math.min(a, b), end: Math.max(a, b) }
}

const DAY = 86_400_000

/** Builds a month axis spanning every dated item, padded to whole months. Null when nothing is dated. */
export function buildTimelineLayout(items: ReadonlyArray<Pick<CrossWorkspaceRoadmapItem, "startDate" | "endDate">>): TimelineLayout | null {
  const spans = items.map(itemSpan).filter((s): s is { start: number; end: number } => s !== null)
  if (spans.length === 0) return null

  const min = new Date(Math.min(...spans.map((s) => s.start)))
  const max = new Date(Math.max(...spans.map((s) => s.end)))
  const axisStart = Date.UTC(min.getUTCFullYear(), min.getUTCMonth(), 1)
  const axisEnd = Date.UTC(max.getUTCFullYear(), max.getUTCMonth() + 1, 1)
  const total = axisEnd - axisStart

  const months: TimelineMonth[] = []
  for (let t = axisStart; t < axisEnd;) {
    const d = new Date(t)
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
    months.push({
      key: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
      label: MONTH_FMT.format(d),
      leftPct: ((t - axisStart) / total) * 100,
      widthPct: ((next - t) / total) * 100,
    })
    t = next
  }

  return {
    months,
    place(item) {
      const span = itemSpan(item)
      if (!span) return null
      const from = span.start
      const to = span.end + DAY // inclusive end day
      return {
        leftPct: ((from - axisStart) / total) * 100,
        // Never thinner than a sliver, so a one-day item is still visible and clickable.
        widthPct: Math.max(((to - from) / total) * 100, 0.8),
      }
    },
  }
}
