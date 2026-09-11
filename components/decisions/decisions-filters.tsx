"use client"

import { useEffect, useRef, useState } from "react"
import { CalendarRange, Search, X } from "lucide-react"

import { useUrlState } from "@/hooks/use-url-state"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { FacetedFilterMenu } from "@/components/patterns/faceted-filter-menu"
import { TRACKED_SUBJECT_LABELS, TRACKED_SUBJECT_TYPES } from "@/lib/tracked-decision-types"

const OUTCOME_OPTIONS = [
  { value: "APPROVE", label: "Approved" },
  { value: "REQUEST_CHANGES", label: "Changes requested" },
  { value: "REJECT", label: "Rejected" },
]

const SEARCH_DEBOUNCE_MS = 300

/**
 * Search / date-range / faceted filters for the Decisions list — collapsed
 * into small header-row triggers (mirroring the Feedback grid's
 * `searchDisplay="popover"` pattern and Tasks/Experiments' FacetedFilterMenu)
 * instead of the always-open 6-column form the page used to render. All
 * state lives in the URL via `useUrlState`, so filtered views stay shareable
 * links exactly like Tasks/Experiments.
 */
export function DecisionsFilters({ reviewers }: { reviewers: { id: string; name: string }[] }) {
  const { params, set } = useUrlState()
  const q = params.get("q") ?? ""
  const from = params.get("from") ?? ""
  const to = params.get("to") ?? ""
  const type = params.get("type")
  const outcome = params.get("outcome")
  const reviewer = params.get("reviewer")

  // Debounced so typing doesn't push a navigation on every keystroke — the
  // external value (back/forward nav) still wins on mismatch, same guard
  // `DebouncedSearchInput` in data-grid-toolbar.tsx uses.
  const [searchValue, setSearchValue] = useState(q)
  const [emittedSearch, setEmittedSearch] = useState<string | null>(null)
  const [previousQ, setPreviousQ] = useState(q)
  if (previousQ !== q) {
    setPreviousQ(q)
    if (q !== emittedSearch) setSearchValue(q)
  }
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (searchTimer.current) clearTimeout(searchTimer.current) }, [])

  function handleSearchChange(next: string) {
    setSearchValue(next)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      setEmittedSearch(next)
      set({ q: next || null, page: null })
    }, SEARCH_DEBOUNCE_MS)
  }

  const [fromValue, setFromValue] = useState(from)
  const [toValue, setToValue] = useState(to)
  const [previousFrom, setPreviousFrom] = useState(from)
  const [previousTo, setPreviousTo] = useState(to)
  if (previousFrom !== from) { setPreviousFrom(from); setFromValue(from) }
  if (previousTo !== to) { setPreviousTo(to); setToValue(to) }
  const dateActive = Boolean(from || to)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" aria-label="Search decisions" />}>
          <Search />
          <span className="hidden sm:inline">Search</span>
          {q && <span className="size-1.5 rounded-full bg-primary" aria-label="Search active" />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72 p-2">
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-text-subtle"
            />
            <Input
              autoFocus
              type="search"
              value={searchValue}
              onChange={(event) => handleSearchChange(event.target.value)}
              placeholder="Search decisions"
              aria-label="Search decisions"
              className="pl-8"
            />
            {searchValue && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => handleSearchChange("")}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-text-subtle hover:text-text-primary"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" aria-label="Filter by date" />}>
          <CalendarRange />
          <span className="hidden sm:inline">Date</span>
          {dateActive && <span className="size-1.5 rounded-full bg-primary" aria-label="Date filter active" />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64 space-y-2 p-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-text-subtle">
            From
            <input
              type="date"
              className="rounded-md border border-border-default bg-surface-app px-2 py-1.5 text-sm text-text-primary"
              value={fromValue}
              onChange={(event) => setFromValue(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-text-subtle">
            To
            <input
              type="date"
              className="rounded-md border border-border-default bg-surface-app px-2 py-1.5 text-sm text-text-primary"
              value={toValue}
              onChange={(event) => setToValue(event.target.value)}
            />
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFromValue("")
                setToValue("")
                set({ from: null, to: null, page: null })
              }}
            >
              Clear
            </Button>
            <Button size="sm" onClick={() => set({ from: fromValue || null, to: toValue || null, page: null })}>
              Apply
            </Button>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <FacetedFilterMenu
        onClearAll={() => set({ type: null, outcome: null, reviewer: null, page: null })}
        groups={[
          {
            id: "type",
            label: "Linked item",
            value: type,
            onValueChange: (value) => set({ type: value, page: null }),
            options: TRACKED_SUBJECT_TYPES.map((subjectType) => ({ value: subjectType, label: TRACKED_SUBJECT_LABELS[subjectType] })),
          },
          {
            id: "outcome",
            label: "Outcome",
            value: outcome,
            onValueChange: (value) => set({ outcome: value, page: null }),
            options: OUTCOME_OPTIONS,
          },
          {
            id: "reviewer",
            label: "Reviewer",
            value: reviewer,
            onValueChange: (value) => set({ reviewer: value, page: null }),
            options: reviewers.map((member) => ({ value: member.id, label: member.name })),
          },
        ]}
      />
    </>
  )
}
