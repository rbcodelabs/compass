"use client"

import { useCallback, useMemo, useTransition, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { ChevronDown, ListFilter, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup,
  DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { HORIZON_META } from "@/lib/roadmap"
import { ROADMAP_DELIVERY_STATUS_LABELS } from "@/lib/roadmap-delivery-status"
import {
  DEFAULT_ROADMAP_FILTERS, ROADMAP_DELIVERY_STATUSES, ROADMAP_HORIZONS, ROADMAP_LINK_FILTERS,
  countActiveFilters, roadmapHref,
  type RoadmapViewDisplay, type RoadmapViewFilters,
} from "@/lib/roadmap-views/schema"
import type { RoadmapViewRecord } from "@/lib/roadmap-views/service"
import { SavedViewsMenu, type RoadmapViewState } from "./saved-views-menu"

type Facets = {
  workspaces: { id: string; name: string; slug: string }[]
  squads: { id: string; name: string; color: string | null; workspaceId: string }[]
}

type Props = {
  orgSlug: string
  surfaceWorkspaceId: string | null
  basePath: string
  title: string
  subtitle: string
  state: RoadmapViewState
  views: RoadmapViewRecord[]
  savedViewId: string | null
  modified: boolean
  facets: Facets
  canShare: boolean
}

const LINK_LABELS = { linked: "Linked", unlinked: "Not linked" } as const
const VIEW_MODE_LABELS: Record<RoadmapViewDisplay["view"], string> = { board: "Board", timeline: "Timeline" }
const GROUP_LABELS: Record<RoadmapViewDisplay["groupBy"], string> = {
  horizon: "Horizon", workspace: "Workspace", squad: "Squad", none: "None",
}
const SORT_LABELS: Record<RoadmapViewDisplay["sort"], string> = {
  manual: "Manual order", startDate: "Start date", endDate: "End date", title: "Title", updated: "Recently updated",
}

function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

function CountBadge({ count }: { count: number }) {
  return (
    <span className="flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
      {count}
    </span>
  )
}

function FilterSub({
  label, count, testId, contentClassName, children,
}: { label: string; count: number; testId: string; contentClassName?: string; children: ReactNode }) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-testid={testId}>
        {label}
        {count > 0 && <CountBadge count={count} />}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className={contentClassName}>{children}</DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

export function RoadmapToolbar({
  orgSlug, surfaceWorkspaceId, basePath, title, subtitle, state, views, savedViewId, modified, facets, canShare,
}: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const { filters, display } = state

  const savedView = views.find((v) => v.id === savedViewId) ?? null
  const savedState = useMemo<RoadmapViewState | null>(
    () => (savedView ? { filters: savedView.filters, display: savedView.display } : null),
    [savedView],
  )

  const navigate = useCallback(
    (next: RoadmapViewState) => {
      startTransition(() => {
        router.push(roadmapHref(basePath, next, { savedViewId, savedState }), { scroll: false })
      })
    },
    [router, basePath, savedViewId, savedState],
  )

  const setFilters = (patch: Partial<RoadmapViewFilters>) => navigate({ filters: { ...filters, ...patch }, display })
  const setDisplay = (patch: Partial<RoadmapViewDisplay>) => navigate({ filters, display: { ...display, ...patch } })

  const selectView = useCallback(
    (view: RoadmapViewRecord | null) => {
      startTransition(() => {
        if (!view) return router.push(basePath, { scroll: false })
        const viewState = { filters: view.filters, display: view.display }
        router.push(roadmapHref(basePath, viewState, { savedViewId: view.id, savedState: viewState }), { scroll: false })
      })
    },
    [router, basePath],
  )

  const activeCount = countActiveFilters(filters)
  // Clearing filters keeps the display options the user chose.
  // Replace, not merge: the defaults omit optional keys (dates, links), so a spread would leave them set.
  const clearFilters = () => navigate({ filters: DEFAULT_ROADMAP_FILTERS, display })

  // Squads are only meaningful next to their workspace; when workspaces are narrowed, only offer those.
  const squadWorkspaces = facets.workspaces.filter(
    (w) => (filters.workspaceIds.length === 0 || filters.workspaceIds.includes(w.id)) && facets.squads.some((s) => s.workspaceId === w.id),
  )

  return (
    // One row, like the workspace roadmap header: title on the left, every control on the right.
    // It wraps onto a second row on narrow screens rather than overflowing.
    <header
      data-slot="workspace-header"
      data-testid="cross-roadmap-toolbar"
      aria-busy={pending}
      className="sticky top-0 z-20 flex shrink-0 flex-wrap items-center gap-x-2 gap-y-2 border-b border-border-default bg-surface-app px-3 py-3 md:static md:px-6"
    >
      <div className="mr-auto flex min-w-0 items-baseline gap-3">
        <h1 className="truncate text-lg font-semibold tracking-tight text-text-primary">{title}</h1>
        <p className="hidden truncate text-xs text-text-secondary sm:block" data-testid="cross-roadmap-subtitle">{subtitle}</p>
      </div>

      <div aria-label="Roadmap controls" className="flex min-w-0 flex-wrap items-center gap-2 md:flex-nowrap">
        <SavedViewsMenu
          orgSlug={orgSlug}
          surfaceWorkspaceId={surfaceWorkspaceId}
          views={views}
          savedViewId={savedViewId}
          modified={modified}
          state={state}
          canShare={canShare}
          onSelect={selectView}
        />

        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="min-h-11 md:min-h-0" data-testid="filters-menu" />}>
            <ListFilter />
            Filters
            {activeCount > 0 && <CountBadge count={activeCount} />}
            <ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <FilterSub label="Workspace" count={filters.workspaceIds.length} testId="filter-workspace" contentClassName="max-h-80 w-56 overflow-y-auto">
              {facets.workspaces.map((w) => (
                <DropdownMenuCheckboxItem
                  key={w.id}
                  checked={filters.workspaceIds.includes(w.id)}
                  closeOnClick={false}
                  onCheckedChange={() => {
                    const workspaceIds = toggle(filters.workspaceIds, w.id)
                    // Drop squads that belong to a workspace that is no longer in scope.
                    const squadIds = workspaceIds.length
                      ? filters.squadIds.filter((id) => workspaceIds.includes(facets.squads.find((s) => s.id === id)?.workspaceId ?? ""))
                      : filters.squadIds
                    setFilters({ workspaceIds, squadIds })
                  }}
                >
                  <span className="truncate">{w.name}</span>
                </DropdownMenuCheckboxItem>
              ))}
            </FilterSub>

            <FilterSub label="Horizon" count={filters.horizons.length} testId="filter-horizon" contentClassName="w-48">
              {ROADMAP_HORIZONS.map((h) => (
                <DropdownMenuCheckboxItem
                  key={h}
                  checked={filters.horizons.includes(h)}
                  closeOnClick={false}
                  onCheckedChange={() => setFilters({ horizons: toggle(filters.horizons, h) })}
                >
                  {HORIZON_META[h].label}
                </DropdownMenuCheckboxItem>
              ))}
            </FilterSub>

            <FilterSub label="Squad" count={filters.squadIds.length} testId="filter-squad" contentClassName="max-h-80 w-56 overflow-y-auto">
              {squadWorkspaces.length === 0 && (
                <p className="px-2 py-1.5 text-xs text-text-subtle">No squads yet.</p>
              )}
              {squadWorkspaces.map((w, index) => (
                <DropdownMenuGroup key={w.id}>
                  {index > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuLabel>{w.name}</DropdownMenuLabel>
                  {facets.squads.filter((s) => s.workspaceId === w.id).map((s) => (
                    <DropdownMenuCheckboxItem
                      key={s.id}
                      checked={filters.squadIds.includes(s.id)}
                      closeOnClick={false}
                      onCheckedChange={() => setFilters({ squadIds: toggle(filters.squadIds, s.id) })}
                    >
                      {s.color && <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />}
                      <span className="truncate">{s.name}</span>
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuGroup>
              ))}
            </FilterSub>

            <FilterSub label="Status" count={filters.deliveryStatuses.length} testId="filter-status" contentClassName="w-52">
              {ROADMAP_DELIVERY_STATUSES.map((s) => (
                <DropdownMenuCheckboxItem
                  key={s}
                  checked={filters.deliveryStatuses.includes(s)}
                  closeOnClick={false}
                  onCheckedChange={() => setFilters({ deliveryStatuses: toggle(filters.deliveryStatuses, s) })}
                >
                  {ROADMAP_DELIVERY_STATUS_LABELS[s]}
                </DropdownMenuCheckboxItem>
              ))}
            </FilterSub>

            <FilterSub label="Links" count={(filters.keyResult ? 1 : 0) + (filters.solution ? 1 : 0)} testId="filter-links" contentClassName="w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Key result</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={filters.keyResult ?? "any"}
                  onValueChange={(v) => setFilters({ keyResult: v === "any" ? undefined : (v as "linked" | "unlinked") })}
                >
                  <DropdownMenuRadioItem value="any">Any</DropdownMenuRadioItem>
                  {ROADMAP_LINK_FILTERS.map((v) => (
                    <DropdownMenuRadioItem key={v} value={v}>{LINK_LABELS[v]}</DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>Solution</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={filters.solution ?? "any"}
                  onValueChange={(v) => setFilters({ solution: v === "any" ? undefined : (v as "linked" | "unlinked") })}
                >
                  <DropdownMenuRadioItem value="any">Any</DropdownMenuRadioItem>
                  {ROADMAP_LINK_FILTERS.map((v) => (
                    <DropdownMenuRadioItem key={v} value={v}>{LINK_LABELS[v]}</DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </FilterSub>

            <FilterSub label="Dates" count={filters.dateFrom || filters.dateTo ? 1 : 0} testId="filter-dates" contentClassName="w-56">
              {/* Typing in a date field must not reach the menu's typeahead / arrow-key handling. */}
              <div className="flex flex-col gap-2 p-2" onKeyDown={(e) => e.stopPropagation()}>
                <label className="flex items-center justify-between gap-2 text-xs text-text-secondary">
                  From
                  <input
                    type="date"
                    aria-label="From date"
                    data-testid="filter-date-from"
                    value={filters.dateFrom ?? ""}
                    max={filters.dateTo}
                    onChange={(e) => setFilters({ dateFrom: e.target.value || undefined })}
                    className="h-7 rounded-md border border-border-default bg-transparent px-1.5 text-xs text-text-primary"
                  />
                </label>
                <label className="flex items-center justify-between gap-2 text-xs text-text-secondary">
                  To
                  <input
                    type="date"
                    aria-label="To date"
                    data-testid="filter-date-to"
                    value={filters.dateTo ?? ""}
                    min={filters.dateFrom}
                    onChange={(e) => setFilters({ dateTo: e.target.value || undefined })}
                    className="h-7 rounded-md border border-border-default bg-transparent px-1.5 text-xs text-text-primary"
                  />
                </label>
              </div>
            </FilterSub>
          </DropdownMenuContent>
        </DropdownMenu>

        {activeCount > 0 && (
          <Button variant="ghost" size="sm" className="min-h-11 md:min-h-0" onClick={clearFilters} data-testid="clear-filters">
            <X /> Clear
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="min-h-11 md:min-h-0" data-testid="display-menu" />}>
            {VIEW_MODE_LABELS[display.view]} · {GROUP_LABELS[display.groupBy]}
            <ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Layout</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={display.view} onValueChange={(v) => setDisplay({ view: v as RoadmapViewDisplay["view"] })}>
                {Object.entries(VIEW_MODE_LABELS).map(([v, label]) => (
                  <DropdownMenuRadioItem key={v} value={v}>{label}</DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Group by</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={display.groupBy} onValueChange={(v) => setDisplay({ groupBy: v as RoadmapViewDisplay["groupBy"] })}>
                {Object.entries(GROUP_LABELS).map(([v, label]) => (
                  <DropdownMenuRadioItem key={v} value={v}>{label}</DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Sort by</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={display.sort} onValueChange={(v) => setDisplay({ sort: v as RoadmapViewDisplay["sort"] })}>
                {Object.entries(SORT_LABELS).map(([v, label]) => (
                  <DropdownMenuRadioItem key={v} value={v}>{label}</DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
