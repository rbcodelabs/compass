"use client"

/**
 * The sort board as a table. The kanban (card-sort-kanban.tsx) is the default
 * view; this one is kept because a table is the better tool for some jobs —
 * scanning 139 rows in one pass, multi-selecting a run of them, or reading the
 * board with a screen reader, where a real table's row/column semantics beat any
 * arrangement of cards.
 *
 * Three ways to reach the same "Propose move to X" menu, deliberately:
 *
 *   1. Right-click a row. This is the gesture the feature was asked for, and
 *      it is the fastest one once you know it exists.
 *   2. The kebab button at the end of every row. Right-click alone is a
 *      discoverability dead end — nothing on screen advertises it — so the same
 *      menu has a visible affordance.
 *   3. Keyboard. The kebab is a real focusable button in tab order, so Tab to a
 *      row's kebab and press Enter or Space. A context menu that only responds
 *      to a mouse button is unusable for anyone who does not use a mouse, and
 *      the row checkboxes are likewise real inputs, so multi-select works from
 *      the keyboard too.
 *
 * The menu itself lives in card-sort-propose-menu.tsx and the requests in
 * use-card-sort-proposals.ts, both shared with the kanban. So a proposal made
 * here and one made by dragging a card there are the same request — which is the
 * property that lets either view be used interchangeably mid-round.
 */

import { useMemo, useState } from "react"
import { ArrowRight } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { ProposeContextMenu, ProposeMenuButton } from "./card-sort-propose-menu"
import type { CardSortView } from "./card-sort-round-header"
import { useCardSortProposals } from "./use-card-sort-proposals"
import { cn } from "@/lib/utils"
import type { SelectOption } from "@/lib/types"

export type BoardRow = {
  objectId: string
  title: string
  currentValue: string | null
  myProposedValue: string | null
  myRationale: string | null
}

export type BoardRound = {
  id: string
  name: string
  state: "OPEN" | "REVEALED" | "CLOSED"
  factorName: string
  /** null while the caller is a participant on an OPEN round. */
  proposalCount: number | null
  myProposalCount: number
}

type Props = {
  orgSlug: string
  workspaceSlug: string
  round: BoardRound
  factor: { id: string; name: string; options: SelectOption[] }
  rows: BoardRow[]
  isFacilitator: boolean
  canSeeTally: boolean
  view?: CardSortView
}

const UNSET = "— no value —"

export function CardSortBoard({
  orgSlug,
  workspaceSlug,
  round,
  factor,
  rows,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const { propose, withdraw, error, working } = useCardSortProposals({
    orgSlug,
    workspaceSlug,
    roundId: round.id,
  })

  const labelFor = useMemo(() => {
    const map = new Map(factor.options.map((option) => [option.value, option.label]))
    return (value: string | null) => (value == null ? UNSET : map.get(value) ?? value)
  }, [factor.options])

  const readOnly = round.state !== "OPEN"

  const proposeAndClear = (objectIds: string[], proposedValue: string) =>
    propose(objectIds, proposedValue).then((result) => {
      if (result) setSelected(new Set())
      return result
    })

  const toggle = (objectId: string) =>
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(objectId)) next.delete(objectId)
      else next.add(objectId)
      return next
    })

  const allSelected = rows.length > 0 && selected.size === rows.length

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {error && (
        <p role="alert" className="rounded-md bg-surface-panel px-3 py-2 text-xs text-text-primary ring-1 ring-border-default">
          {error}
        </p>
      )}

      {selected.size > 0 && !readOnly && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-surface-panel px-3 py-2 ring-1 ring-border-default">
          <span className="text-sm font-medium">
            {selected.size} selected
          </span>
          {/*
            The bulk menu offers every bucket, including ones some selected rows
            are already in — it cannot know which without re-deriving per row, and
            the server skips those and reports them back as `skipped`.
          */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button size="sm" disabled={working}>
                  Propose move for all {selected.size}
                </Button>
              }
            />
            <DropdownMenuContent className="w-64">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Propose move to&hellip;</DropdownMenuLabel>
                {factor.options.map((option) => (
                  <DropdownMenuItem
                    key={option.value}
                    onClick={() => proposeAndClear([...selected], option.value)}
                  >
                    <ArrowRight className="size-4" /> {option.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
          <span className="text-xs text-text-secondary">
            Rows already in the bucket you pick are left alone.
          </span>
        </div>
      )}

      {/*
        The bounded height and the vertical scroll go on Table's own container via
        containerClassName, not on a wrapper outside it. That container is already
        a scroll container, so it is what a sticky header resolves against — put
        the overflow one level out and the header scrolls away with the rows.
      */}
      <div className="flex min-h-0 flex-1 flex-col rounded-md ring-1 ring-border-default">
        <Table
          className="text-sm"
          containerClassName="min-h-0 flex-1 overflow-y-auto"
        >
          <TableHeader className="sticky top-0 z-10 bg-surface-panel">
            <TableRow className="text-left">
              <TableHead scope="col" className="w-10 px-3 py-2">
                <Checkbox
                  aria-label={allSelected ? "Deselect all rows" : "Select all rows"}
                  checked={allSelected}
                  disabled={readOnly}
                  onCheckedChange={() =>
                    setSelected(allSelected ? new Set() : new Set(rows.map((row) => row.objectId)))
                  }
                />
              </TableHead>
              <TableHead scope="col" className="px-3 py-2 font-medium">
                Object
              </TableHead>
              <TableHead scope="col" className="px-3 py-2 font-medium">
                Current {factor.name}
              </TableHead>
              <TableHead scope="col" className="px-3 py-2 font-medium">
                Your proposal
              </TableHead>
              <TableHead scope="col" className="w-12 px-3 py-2">
                <span className="sr-only">Row actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, index) => {
              // Grouping is a visual break at each change of current bucket.
              // The server already sorted rows into the factor's own option
              // order, so this needs no sort of its own.
              const startsGroup = index === 0 || rows[index - 1].currentValue !== row.currentValue
              const menu = {
                title: row.title,
                options: factor.options,
                currentValue: row.currentValue,
                myProposedValue: row.myProposedValue,
                onPropose: (value: string) => propose([row.objectId], value),
                onWithdraw: () => withdraw(row.objectId),
              }

              return (
                <TableRow
                  key={row.objectId}
                  // TableRow already styles data-state="selected"; reusing its
                  // convention keeps row selection looking the same everywhere.
                  data-state={selected.has(row.objectId) ? "selected" : undefined}
                  className={cn(startsGroup && index > 0 && "border-t-2 border-border-default")}
                >
                  <TableCell className="px-3 py-2 align-top">
                    <Checkbox
                      aria-label={`Select ${row.title}`}
                      checked={selected.has(row.objectId)}
                      disabled={readOnly}
                      onCheckedChange={() => toggle(row.objectId)}
                    />
                  </TableCell>
                  {/*
                    The right-click surface is the two data cells rather than the
                    whole row: wrapping a table row in a non-row element would
                    break the table's structure and therefore its semantics for
                    a screen reader.
                  */}
                  <TableCell className="px-3 py-2 align-top">
                    {readOnly ? (
                      row.title
                    ) : (
                      <ProposeContextMenu {...menu} className="block w-full text-left">
                        {row.title}
                      </ProposeContextMenu>
                    )}
                  </TableCell>
                  <TableCell className="px-3 py-2 align-top text-text-secondary">
                    {labelFor(row.currentValue)}
                  </TableCell>
                  <TableCell className="px-3 py-2 align-top">
                    {row.myProposedValue ? (
                      <Badge variant="outline" className="gap-1">
                        <ArrowRight className="size-3" />
                        {labelFor(row.myProposedValue)}
                      </Badge>
                    ) : (
                      <span className="text-xs text-text-secondary">no opinion recorded</span>
                    )}
                  </TableCell>
                  <TableCell className="px-3 py-2 align-top">
                    {!readOnly && <ProposeMenuButton {...menu} busy={working} />}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
