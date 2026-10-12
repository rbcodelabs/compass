import Link from "next/link"
import { CalendarDays, Target } from "lucide-react"
import { DeliveryStatusBadge } from "@/components/roadmap/delivery-status-badge"
import { HORIZON_META } from "@/lib/roadmap"
import { buildTimelineLayout, type RoadmapGroup } from "@/lib/roadmap-views/group"
import type { CrossWorkspaceRoadmapItem } from "@/lib/roadmap-views/query"

/**
 * Read-only renderers for the cross-workspace roadmap. Server components: nothing
 * here is interactive beyond links, and every card links to the item in its OWN
 * workspace, where editing lives (the cross-workspace view never mutates).
 */

function itemHref(orgSlug: string, item: CrossWorkspaceRoadmapItem) {
  return `/${orgSlug}/${item.workspace.slug}/roadmap/${item.id}`
}

// UTC, matching RoadmapCard: dates are stored as UTC midnight.
const DATE_FMT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
function dateRange(item: Pick<CrossWorkspaceRoadmapItem, "startDate" | "endDate">): string | null {
  const start = item.startDate ? DATE_FMT.format(new Date(item.startDate)) : null
  const end = item.endDate ? DATE_FMT.format(new Date(item.endDate)) : null
  if (start && end) return `${start} – ${end}`
  if (start) return `From ${start}`
  if (end) return `Until ${end}`
  return null
}

function GroupDot({ color }: { color?: string }) {
  return color ? <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} /> : null
}

function ReadOnlyCard({ orgSlug, item, showWorkspace }: { orgSlug: string; item: CrossWorkspaceRoadmapItem; showWorkspace: boolean }) {
  const range = dateRange(item)
  const krPct = item.keyResult && item.keyResult.target > 0 ? Math.round((item.keyResult.current / item.keyResult.target) * 100) : null
  return (
    <li>
      <Link
        href={itemHref(orgSlug, item)}
        data-testid="cross-roadmap-card"
        className="block rounded-lg border border-border-default bg-surface-card p-3 transition-colors hover:border-primary/40 hover:bg-surface-interactive-hover focus-visible:outline-2 focus-visible:outline-primary"
      >
        <span className="line-clamp-2 text-sm font-medium text-text-primary">{item.title}</span>
        <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary">
          {showWorkspace && <span className="rounded border border-border-default px-1.5 py-0.5 font-medium">{item.workspace.name}</span>}
          {item.squad && (
            <span className="inline-flex items-center gap-1"><GroupDot color={item.squad.color} />{item.squad.name}</span>
          )}
          {range && <span className="inline-flex items-center gap-1"><CalendarDays className="size-3" aria-hidden="true" />{range}</span>}
          {krPct !== null && item.keyResult && (
            <span className="inline-flex items-center gap-1" title={item.keyResult.title}><Target className="size-3" aria-hidden="true" />{krPct}%</span>
          )}
        </span>
        <span className="mt-2 flex items-center gap-2">
          <DeliveryStatusBadge status={item.deliveryStatus} />
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${HORIZON_META[item.horizon].badgeClass}`}>{HORIZON_META[item.horizon].label}</span>
        </span>
      </Link>
    </li>
  )
}

export function RoadmapBoardResults({ orgSlug, groups, groupBy }: { orgSlug: string; groups: RoadmapGroup[]; groupBy: string }) {
  return (
    <div className="flex min-h-0 flex-1 gap-4 overflow-x-auto p-4 md:p-6" data-testid="cross-roadmap-board">
      {groups.map((group) => (
        <section key={group.key} aria-label={group.label} className="flex w-72 shrink-0 flex-col gap-3" data-testid="cross-roadmap-group">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <GroupDot color={group.color} />
            <span className="truncate">{group.label}</span>
            <span className="text-xs font-normal tabular-nums text-text-subtle">{group.items.length}</span>
          </h2>
          {group.items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border-default p-3 text-xs text-text-subtle">Nothing here.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {group.items.map((item) => (
                <ReadOnlyCard key={item.id} orgSlug={orgSlug} item={item} showWorkspace={groupBy !== "workspace"} />
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  )
}

export function RoadmapTimelineResults({ orgSlug, groups, groupBy }: { orgSlug: string; groups: RoadmapGroup[]; groupBy: string }) {
  const all = groups.flatMap((g) => g.items)
  const layout = buildTimelineLayout(all)
  const undated = all.filter((item) => layout?.place(item) == null)

  if (!layout) {
    return (
      <div className="p-6" data-testid="cross-roadmap-timeline">
        <p className="rounded-lg border border-dashed border-border-default p-6 text-sm text-text-secondary">
          None of these items have dates yet, so there is nothing to place on a timeline. Switch to the board, or add start and end dates to the items.
        </p>
        {all.length > 0 && <UndatedList orgSlug={orgSlug} items={undated} showWorkspace={groupBy !== "workspace"} />}
      </div>
    )
  }

  return (
    <div className="overflow-x-auto p-4 md:p-6" data-testid="cross-roadmap-timeline">
      <div className="min-w-[720px]">
        <div className="relative ml-44 h-6 border-b border-border-default text-[11px] text-text-subtle" aria-hidden="true">
          {layout.months.map((m) => (
            <span key={m.key} className="absolute top-0 border-l border-border-default pl-1" style={{ left: `${m.leftPct}%`, width: `${m.widthPct}%` }}>{m.label}</span>
          ))}
        </div>
        {groups.map((group) => {
          const dated = group.items.filter((item) => layout.place(item))
          if (dated.length === 0) return null
          return (
            <section key={group.key} aria-label={group.label} className="border-b border-border-default py-2" data-testid="cross-roadmap-group">
              <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-text-primary">
                <GroupDot color={group.color} /><span className="truncate">{group.label}</span>
              </h2>
              <ul className="flex flex-col gap-1">
                {dated.map((item) => {
                  const pos = layout.place(item)!
                  return (
                    <li key={item.id} className="flex items-center">
                      <span className="w-44 shrink-0 truncate pr-2 text-xs text-text-secondary" title={item.title}>
                        {groupBy !== "workspace" && <span className="text-text-subtle">{item.workspace.name} · </span>}{item.title}
                      </span>
                      <span className="relative h-6 flex-1">
                        <Link
                          href={itemHref(orgSlug, item)}
                          aria-label={`${item.title}, ${item.workspace.name}${dateRange(item) ? `, ${dateRange(item)}` : ""}`}
                          className="absolute top-0.5 h-5 rounded px-1.5 text-[11px] font-medium leading-5 text-white hover:brightness-110 focus-visible:outline-2 focus-visible:outline-primary"
                          style={{ left: `${pos.leftPct}%`, width: `${pos.widthPct}%`, backgroundColor: HORIZON_META[item.horizon].color }}
                          data-testid="cross-roadmap-bar"
                        >
                          <span className="block truncate">{item.title}</span>
                        </Link>
                      </span>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
        {undated.length > 0 && <UndatedList orgSlug={orgSlug} items={undated} showWorkspace={groupBy !== "workspace"} />}
      </div>
    </div>
  )
}

function UndatedList({ orgSlug, items, showWorkspace }: { orgSlug: string; items: CrossWorkspaceRoadmapItem[]; showWorkspace: boolean }) {
  if (items.length === 0) return null
  return (
    <section aria-label="Unscheduled" className="mt-4" data-testid="cross-roadmap-unscheduled">
      <h2 className="mb-2 text-sm font-semibold text-text-primary">Unscheduled <span className="text-xs font-normal tabular-nums text-text-subtle">{items.length}</span></h2>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => <ReadOnlyCard key={item.id} orgSlug={orgSlug} item={item} showWorkspace={showWorkspace} />)}
      </ul>
    </section>
  )
}
