"use client"

/**
 * The sort board as a kanban.
 *
 * ── The one invariant ───────────────────────────────────────────────────────
 *
 * A drag NEVER writes the official custom field value. Dropping a card creates,
 * updates or withdraws a PROPOSAL, and nothing else. components/discovery/
 * opportunity-board.tsx is the reference for the dnd-kit idiom below, but its
 * drop handler calls moveOpportunity() and mutates the record — correct there,
 * forbidden here. The difference is enforced in lib/card-sort-kanban.ts, whose
 * CardDropPlan cannot express "set the official value", and in
 * use-card-sort-proposals.ts, which has no endpoint that could.
 *
 * ── Three treatments, and why ───────────────────────────────────────────────
 *
 * The drag lands. Propose a move and the solid card appears in the target column
 * — it looks like a card, because that is where you put it — while its official
 * column shows a dashed outline where it used to be. The hole is what keeps
 * official state readable: a column visibly missing one of its members reads as
 * "this is contested" far better than a column that looks untouched.
 *
 * Nothing about that writes the official value. `officialCount`, not the number
 * of cards rendered, is what the column header reports, so moving a card never
 * makes the header claim membership nobody set. Everything proposed INTO a
 * column is a separate +n chip beside it.
 *
 * Other people's proposals get the third treatment: a compact marker, not a solid
 * card. After a reveal one object can have three rival destinations, and it
 * cannot be solid in three columns at once. The marker is deliberately unlike a
 * card so "where I put it" and "where somebody else wants it" are distinguishable
 * without hovering; the aggregate story belongs to the flow-arrow tally.
 *
 * ── Real cards ─────────────────────────────────────────────────────────────
 *
 * Cards are the object's real card — EntityCard with the same content the
 * discovery board shows — and the title opens the same `?detail=` panel. See
 * SolidCard for why this is not components/discovery/opportunity-card itself.
 *
 * ── Accessibility ──────────────────────────────────────────────────────────
 *
 * Drag is one route in, never the only one. Every card carries the same
 * "Propose move to…" menu as the table, reachable by right-click and by a real
 * focusable button, both wired to the same handlers as the drop. The drag handle
 * is a named button (dnd-kit's KeyboardSensor: Space picks up, arrows move,
 * Space drops); the menu button is the path a Tab key finds unaided.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react"
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import { ArrowRight, ChevronLeft, ChevronRight, GripVertical, Users, X } from "lucide-react"

import { Board, BoardColumn } from "@/components/patterns/board"
import { EntityCard } from "@/components/patterns/entity-card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { EvidenceBadge } from "@/components/discovery/evidence-badge"
import { ScoreBadge } from "@/components/discovery/score-badge"
import { usePanelContext, type EntityPanelType } from "@/components/panels/panel-context"
import { ProposeContextMenu, ProposeMenuButton } from "./card-sort-propose-menu"
import type { CardSortView } from "./card-sort-round-header"
import { InfoHint } from "./card-sort-info"
import { useCardSortProposals } from "./use-card-sort-proposals"
import {
  NewEntryCard,
  ProposeNewEntryButton,
  type NewEntryItem,
} from "./card-sort-new-entries"
import {
  buildKanbanColumns,
  NO_VALUE_COLUMN_VALUE,
  planCardDrop,
  type IncomingMarker,
  type KanbanColumn,
  type PlacedCard,
  type VacatedSlot,
} from "@/lib/card-sort-kanban"
import { cn } from "@/lib/utils"
import type { CardSortBoardProposal } from "@/lib/card-sort"
import type { CardSortCardMeta } from "@/lib/card-sort-cards"
import type { BoardRound } from "./card-sort-board"
import type { CustomFieldObjectType, SelectOption } from "@/lib/types"

type Props = {
  orgSlug: string
  workspaceSlug: string
  round: BoardRound
  /** Which detail panel a title opens. Defaults to opportunity. */
  objectType?: CustomFieldObjectType
  factor: { id: string; name: string; options: SelectOption[] }
  rows: { objectId: string; title: string; currentValue: string | null }[]
  /** Proposals the server decided this caller may see. Never filtered here. */
  proposals: CardSortBoardProposal[]
  /** Real-card fields per object; empty for types that have none. */
  cardMeta?: Record<string, CardSortCardMeta>
  showScore?: boolean
  isFacilitator: boolean
  canSeeTally: boolean
  view?: CardSortView
  /**
   * Requests for brand-new entries, already filtered by the server (see
   * listCardSortNewEntries). Pending ones render as cards in the column their
   * proposer suggested; they never touch a column's official count.
   */
  newEntries?: NewEntryItem[]
  /** OPPORTUNITY round that is still OPEN: show the propose button and Withdraw. */
  canProposeNewEntries?: boolean
  /** The facilitator, while the round is not CLOSED: show Accept / Reject. */
  canResolveNewEntries?: boolean
}

/** Drop-target payload, so the drag handler never has to parse an id. */
type ColumnDropData = { columnValue: string | null }

// ── Cards ───────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  EXPLORING: "Exploring",
  VALIDATING: "Validating",
  PRIORITIZED: "Prioritized",
  ACTIVE: "Active",
  ARCHIVED: "Archived",
}

/**
 * Which detail panel a card opens — the `?detail=<type>:<id>` slot the rest of
 * the workspace already uses, so every sortable object type opens its own panel.
 */
const PANEL_FOR: Record<CustomFieldObjectType, EntityPanelType> = {
  OPPORTUNITY: "opportunity",
  SOLUTION: "solution",
  EXPERIMENT: "experiment",
  OBJECTIVE: "objective",
  KEY_RESULT: "keyResult",
  ROADMAP_ITEM: "roadmapItem",
  TASK: "task",
}

type CardContext = {
  options: readonly SelectOption[]
  draggable: boolean
  panelType: EntityPanelType
  meta: Record<string, CardSortCardMeta>
  showScore: boolean
  scoringHref: (objectId: string) => string
  onPropose: (objectId: string, proposedValue: string) => void
  onWithdraw: (objectId: string) => void
}

/**
 * The object's real card.
 *
 * Built on EntityCard with the same content as components/discovery/
 * opportunity-card (squad dot, segment, status, solution / evidence / score
 * badges) rather than that component itself: its menu moves status and
 * archives — real writes this board must not offer — and it is bound to the
 * discovery board's sortable list. Here the only menu is the propose menu, and
 * the title opens the same detail panel the discovery board does.
 */
function SolidCard({ card, ctx }: { card: PlacedCard; ctx: CardContext }) {
  const { openPanel } = usePanelContext()
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: card.objectId,
    disabled: !ctx.draggable,
  })

  const landed = card.placement === "proposed"
  const meta = ctx.meta[card.objectId]

  const menu = {
    title: card.title,
    options: ctx.options,
    currentValue: card.currentValue,
    myProposedValue: card.myProposedValue,
    onPropose: (value: string) => ctx.onPropose(card.objectId, value),
    onWithdraw: () => ctx.onWithdraw(card.objectId),
  }

  const hasBadges = Boolean(meta) || card.othersProposedTo.length > 0
  const hasFoot = Boolean(meta) || landed

  const article = (
    <EntityCard
      interactive
      selected={landed}
      title={
        <button
          type="button"
          onClick={() => openPanel(ctx.panelType, card.objectId)}
          className="line-clamp-2 text-left underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
        >
          {card.title}
        </button>
      }
      description={meta?.description ?? undefined}
      leading={
        ctx.draggable || meta?.squad ? (
          <div className="flex items-center gap-1.5 pt-0.5">
            {ctx.draggable && (
              <button
                type="button"
                ref={setActivatorNodeRef}
                {...attributes}
                {...listeners}
                aria-label={`Drag ${card.title} to propose a move`}
                className="shrink-0 cursor-grab touch-none rounded text-text-subtle/60 hover:text-text-subtle active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus"
              >
                <GripVertical className="size-3.5" aria-hidden />
              </button>
            )}
            {meta?.squad && (
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: meta.squad.color }}
                title={meta.squad.name}
              />
            )}
          </div>
        ) : undefined
      }
      actions={ctx.draggable ? <ProposeMenuButton {...menu} /> : undefined}
      className={cn(
        "w-full p-3",
        // A proposal wears a tint, so "mine, not official" reads before any text does.
        landed && "border-status-info/60 bg-status-info-surface"
      )}
    >
      {hasBadges || hasFoot ? (
        <div className="mt-2 flex flex-col gap-2">
          {hasBadges && (
            <div className="flex flex-wrap items-center gap-1.5">
              {meta && ctx.showScore && (
                <ScoreBadge score={meta.score} scoringHref={ctx.scoringHref(card.objectId)} />
              )}
              {meta && (
                <>
                  <Badge variant="secondary">
                    {meta.solutionCount} {meta.solutionCount === 1 ? "solution" : "solutions"}
                  </Badge>
                  <EvidenceBadge count={meta.evidenceCount} sourceCount={meta.evidenceSourceCount} />
                </>
              )}
              {/* Other people's destinations for this object, after a reveal. */}
              {card.othersProposedTo.map((target) => (
                <Badge key={target.value} variant="outline" className="gap-1">
                  <ArrowRight className="size-3" aria-hidden />
                  {target.label}
                  {target.count > 1 && (
                    <span className="text-text-secondary">&times;{target.count}</span>
                  )}
                </Badge>
              ))}
            </div>
          )}
          {hasFoot && (
            <div className="flex items-center justify-between gap-2 text-xs text-text-subtle">
              <span>{meta ? (STATUS_LABEL[meta.status] ?? meta.status) : null}</span>
              {landed && (
                /*
                  The one thing a landed card must never let the reader forget: it
                  has not actually moved. "was X" is where the database still has it.
                */
                <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 py-0.5 pr-0.5 pl-2 text-text-secondary">
                  <span>
                    <span className="sr-only">Your proposal; officially still in </span>
                    <span aria-hidden>was </span>
                    <span className="font-medium">{card.currentLabel}</span>
                  </span>
                  {ctx.draggable && (
                    <button
                      type="button"
                      aria-label={`Withdraw proposal for ${card.title}`}
                      onClick={() => ctx.onWithdraw(card.objectId)}
                      className="inline-flex size-4 items-center justify-center rounded-full hover:bg-primary/15 focus-visible:outline-2 focus-visible:outline-border-focus"
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  )}
                </span>
              )}
            </div>
          )}
        </div>
      ) : null}
    </EntityCard>
  )

  return (
    <div ref={setNodeRef} data-dragging={isDragging || undefined} className="data-dragging:opacity-40">
      {ctx.draggable ? (
        <ProposeContextMenu {...menu} className="block">
          {article}
        </ProposeContextMenu>
      ) : (
        article
      )}
    </div>
  )
}

/** Hatching for the ghost: reads as "an absence" without another colour. */
const GHOST_HATCH = {
  backgroundImage:
    "repeating-linear-gradient(135deg, transparent 0 7px, var(--color-surface-inset) 7px 8px)",
}

/**
 * The hole a landed card left behind — the ghost. Still officially here.
 *
 * The same real card, drawn as an absence: dashed border, hatched and faded,
 * desaturated, no shadow. Hovering brings it back to full strength so it can
 * be read. The title still opens the detail panel by mouse, but nothing here
 * is a tab stop — the solid card is the one to act on, and withdraw lives there.
 */
function VacatedOutline({ slot, ctx }: { slot: VacatedSlot; ctx: CardContext }) {
  const { openPanel } = usePanelContext()
  const meta = ctx.meta[slot.objectId]

  return (
    <EntityCard
      data-ghost
      title={
        <button
          type="button"
          tabIndex={-1}
          onClick={() => openPanel(ctx.panelType, slot.objectId)}
          className="line-clamp-2 text-left text-text-secondary underline-offset-2 hover:underline"
        >
          <span className="sr-only">Still officially here: </span>
          {slot.title}
        </button>
      }
      description={meta?.description ?? undefined}
      leading={
        meta?.squad ? (
          <span
            className="mt-1.5 block size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: meta.squad.color }}
            title={meta.squad.name}
          />
        ) : undefined
      }
      style={GHOST_HATCH}
      className="w-full border-2 border-dashed border-border-strong bg-transparent p-3 opacity-60 shadow-none grayscale transition hover:opacity-100 hover:grayscale-0"
    >
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        {meta ? (
          // inert: the score badge is a link, and the ghost must not add tab stops.
          <div inert className="flex flex-wrap items-center gap-1.5">
            {ctx.showScore && (
              <ScoreBadge score={meta.score} scoringHref={ctx.scoringHref(slot.objectId)} />
            )}
            <Badge variant="secondary">
              {meta.solutionCount} {meta.solutionCount === 1 ? "solution" : "solutions"}
            </Badge>
          </div>
        ) : (
          <span />
        )}
        <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-border-strong bg-surface-card px-2 py-0.5 text-xs text-text-secondary">
          <span className="sr-only">you proposed moving it to</span>
          <ArrowRight className="size-3" aria-hidden />
          <span className="font-medium">{slot.movedToLabel}</span>
        </span>
      </div>
    </EntityCard>
  )
}

/**
 * Somebody else wants this object here. Markedly not card-shaped, so it cannot
 * be mistaken for the viewer's own landed card; keeps the who-and-why drill-in.
 */
function IncomingMarkerView({ marker }: { marker: IncomingMarker }) {
  const detailId = `incoming-${marker.objectId}-detail`

  return (
    <Collapsible className="flex flex-col gap-0.5 border-l-2 border-border-default pl-2">
      <span className="truncate text-sm text-text-secondary">{marker.title}</span>
      <span className="flex flex-wrap items-center gap-1 text-xs text-text-subtle">
        <span>from {marker.fromLabel}</span>
        <span aria-hidden>&middot;</span>
        <CollapsibleTrigger
          className="inline-flex items-center gap-1 underline decoration-dotted"
          aria-controls={detailId}
        >
          <Users className="size-3" aria-hidden />
          {marker.proposerCount}
          <span className="sr-only">
            {" "}
            proposer{marker.proposerCount === 1 ? "" : "s"} — show who and why
          </span>
        </CollapsibleTrigger>
      </span>
      <CollapsibleContent id={detailId}>
        <ul className="mt-1 flex flex-col gap-0.5 text-xs text-text-secondary">
          {marker.proposers.map((proposer) => (
            <li key={proposer.userId}>
              <span className="font-medium">{proposer.userName}</span>
              {proposer.rationale ? `: ${proposer.rationale}` : ""}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

// ── Column ──────────────────────────────────────────────────────────────────

type NewEntryColumnProps = {
  orgSlug: string
  workspaceSlug: string
  roundId: string
  canResolve: boolean
  canWithdraw: boolean
}

function KanbanColumnView({
  column,
  ctx,
  entries,
  entryProps,
}: {
  column: KanbanColumn
  ctx: CardContext
  /** Pending new-entry requests that belong in this column. */
  entries: NewEntryItem[]
  entryProps: NewEntryColumnProps
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: column.id,
    // The value travels in `data`, so the drop handler never parses an id. Option
    // values are free text; a "column-<value>" id would be ambiguous to split.
    data: { columnValue: column.value } satisfies ColumnDropData,
    disabled: !ctx.draggable,
  })

  /*
    The count badge is officialCount — how many objects actually hold this value —
    and never the number of cards rendered. Those diverge the moment the viewer
    lands a card here; a badge that counted cards would be quietly asserting a
    change to CustomFieldValue that nobody has made.
  */
  const proposedIn =
    column.cards.filter((card) => card.placement === "proposed").length + column.incoming.length

  const empty =
    column.cards.length === 0 &&
    column.vacated.length === 0 &&
    column.incoming.length === 0 &&
    entries.length === 0

  return (
    <BoardColumn
      aria-label={`${column.label}: ${column.officialCount} official${
        proposedIn > 0 ? `, ${proposedIn} proposed in` : ""
      }`}
      title={column.label}
      count={column.officialCount}
      actions={
        proposedIn > 0 ? (
          <span
            title={`${proposedIn} proposed into ${column.label}`}
            className="rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-text-primary"
          >
            +{proposedIn}
          </span>
        ) : undefined
      }
      bodyRef={setNodeRef}
      // Fill the board instead of the shared pattern's fixed w-72 / 65vh: columns
      // split the width evenly (never narrower than 16rem, so a wide factor still
      // scrolls sideways) and run to the bottom of the page, each scrolling on its
      // own. The drop zone is the whole column height, not just the cards.
      className="w-auto min-w-64 flex-1 shrink md:min-h-0"
      bodyClassName={cn(
        // md:overscroll-auto undoes BoardColumn's overscroll-y-contain. A real
        // trackpad swipe always carries a little vertical motion, and Chromium
        // hands the whole wheel event to a `contain` scroller under the cursor
        // instead of chaining the horizontal part up to the Board, so the board
        // would not move sideways anywhere over a column.
        "min-h-24 md:max-h-none md:min-h-0 md:flex-1 md:overscroll-auto",
        isOver && "rounded-lg bg-primary/5 ring-2 ring-inset ring-ring/25"
      )}
      emptyState={empty ? <p className="text-xs text-text-subtle">Nothing here yet</p> : undefined}
    >
      {column.cards.map((card) => (
        <SolidCard key={card.objectId} card={card} ctx={ctx} />
      ))}

      {entries.map((entry) => (
        <NewEntryCard key={entry.id} entry={entry} {...entryProps} />
      ))}

      {column.vacated.length > 0 && (
        <section aria-label={`Proposed away from ${column.label}`} className="flex flex-col gap-2">
          {column.vacated.map((slot) => (
            <VacatedOutline key={`${slot.objectId}-vacated`} slot={slot} ctx={ctx} />
          ))}
        </section>
      )}

      {column.incoming.length > 0 && (
        <section aria-label={`Others propose into ${column.label}`} className="flex flex-col gap-2 pt-1">
          <h4 className="text-xs font-medium text-text-subtle">Others propose</h4>
          {column.incoming.map((marker) => (
            <IncomingMarkerView key={`${marker.objectId}-incoming`} marker={marker} />
          ))}
        </section>
      )}
    </BoardColumn>
  )
}

/** Official / proposed-away / yours key, with what the column numbers mean behind an ⓘ. */
function ZoneKey() {
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-text-secondary">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-3 w-4 rounded-sm border border-border-default bg-surface-card" />
          Official
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            style={GHOST_HATCH}
            className="inline-block h-3 w-4 rounded-sm border border-dashed border-border-strong opacity-70"
          />
          Proposed away
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-3 w-4 rounded-sm border border-status-info/60 bg-status-info-surface ring-2 ring-ring/15" />
          Your proposal
        </span>
        <InfoHint label="What the counts mean">
          <p>
            The number beside a column is how many items <strong>officially</strong> sit in it
            right now.
          </p>
          <p>
            The <strong>+n</strong> chip counts items someone has proposed moving <em>into</em> it.
            Official values don&rsquo;t change until someone applies the result.
          </p>
        </InfoHint>
    </div>
  )
}

// ── Board ───────────────────────────────────────────────────────────────────

export function CardSortKanban({
  orgSlug,
  workspaceSlug,
  round,
  objectType = "OPPORTUNITY",
  factor,
  rows,
  proposals,
  cardMeta = {},
  showScore = false,
  newEntries = [],
  canProposeNewEntries = false,
  canResolveNewEntries = false,
}: Props) {
  const { propose, withdraw, error, setError } = useCardSortProposals({
    orgSlug,
    workspaceSlug,
    roundId: round.id,
  })
  const [draggingId, setDraggingId] = useState<string | null>(null)

  // Drag is off unless the round is OPEN. The server rejects a proposal on a
  // REVEALED or CLOSED round regardless (lib/card-sort.ts is the authority);
  // this is so the gesture is visibly unavailable rather than silently failing.
  const draggable = round.state === "OPEN"

  const columns = useMemo(
    () =>
      buildKanbanColumns({
        options: factor.options,
        rows,
        proposals: proposals.map((proposal) => ({
          objectId: proposal.objectId,
          userId: proposal.userId,
          userName: proposal.userName,
          proposedValue: proposal.proposedValue,
          fromValue: proposal.fromValue,
          rationale: proposal.rationale,
          isMine: proposal.isMine,
        })),
      }),
    [factor.options, rows, proposals]
  )

  // Pending requests go in the column their proposer suggested; a request with
  // no suggestion (or one naming a value this board has no column for) goes in
  // the no-value column, so it is never silently dropped from view. Accepted and
  // rejected requests draw nothing: an accepted one is a real card now.
  const entriesByColumn = useMemo(() => {
    const known = new Set(columns.map((column) => column.value))
    const map = new Map<string | null, NewEntryItem[]>()
    for (const entry of newEntries) {
      if (entry.status !== "PENDING") continue
      const key =
        entry.suggestedValue !== null && known.has(entry.suggestedValue)
          ? entry.suggestedValue
          : NO_VALUE_COLUMN_VALUE
      const list = map.get(key)
      if (list) list.push(entry)
      else map.set(key, [entry])
    }
    return map
  }, [columns, newEntries])

  const entryProps: NewEntryColumnProps = {
    orgSlug,
    workspaceSlug,
    roundId: round.id,
    canResolve: canResolveNewEntries,
    canWithdraw: canProposeNewEntries,
  }

  const cardsById = useMemo(() => {
    const map = new Map<string, PlacedCard>()
    for (const column of columns) {
      for (const card of column.cards) map.set(card.objectId, card)
    }
    return map
  }, [columns])

  const dndContextId = useId()

  // The board scrolls sideways natively, but overlay scrollbars are invisible on
  // macOS and a mouse wheel has no horizontal axis, so wide boards read as cut
  // off with no way across. These buttons are the explicit route.
  const rootRef = useRef<HTMLDivElement>(null)
  function scrollColumns(direction: -1 | 1) {
    const board = rootRef.current?.querySelector<HTMLElement>('[role="region"]')
    board?.scrollBy({ left: direction * board.clientWidth * 0.8, behavior: "smooth" })
  }

  // A trackpad swipe is never purely horizontal. Over a column that scrolls on its
  // own, Chromium gives the whole gesture to that column: it takes the vertical
  // sliver and the sideways part is lost, so the board will not move. When a swipe
  // is mainly sideways, drive the board ourselves. Mainly vertical swipes are left
  // alone so columns still scroll normally. The listener is attached by hand
  // because React's onWheel is passive and cannot preventDefault.
  useEffect(() => {
    const board = rootRef.current?.querySelector<HTMLElement>('[role="region"]')
    if (!board) return
    function onWheel(event: WheelEvent) {
      if (!board || event.ctrlKey) return
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return
      if (board.scrollWidth <= board.clientWidth) return
      // With scroll-snap on, each small step would be snapped straight back to the
      // column edge it started from, so the board would just jiggle. Snap is only
      // off from md up; below that, leave the swipe to the browser.
      if (getComputedStyle(board).scrollSnapType !== "none") return
      event.preventDefault()
      board.scrollLeft += event.deltaX
    }
    board.addEventListener("wheel", onWheel, { passive: false })
    return () => board.removeEventListener("wheel", onWheel)
  }, [])

  const sensors = useSensors(
    // distance:8 so a click on a card's title or menu is a click, not a
    // one-pixel drag that swallows it.
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor)
  )

  const ctx: CardContext = {
    options: factor.options,
    draggable,
    panelType: PANEL_FOR[objectType],
    meta: cardMeta,
    showScore,
    scoringHref: (objectId) => `/${orgSlug}/${workspaceSlug}/discovery/${objectId}?tab=scoring`,
    onPropose: (objectId, proposedValue) => propose([objectId], proposedValue),
    onWithdraw: withdraw,
  }

  function handleDragStart(event: DragStartEvent) {
    setDraggingId(String(event.active.id))
  }

  function handleDragEnd(event: DragEndEvent) {
    setDraggingId(null)
    const card = cardsById.get(String(event.active.id))
    const target = event.over?.data.current as ColumnDropData | undefined
    // Dropped outside any column. Not an error and not a proposal — the user
    // changed their mind mid-drag.
    if (!card || !event.over || !target) return

    const plan = planCardDrop({
      card: {
        objectId: card.objectId,
        currentValue: card.currentValue,
        myProposedValue: card.myProposedValue,
      },
      targetValue: target.columnValue,
      roundState: round.state,
    })

    if (plan.kind === "propose") propose([plan.objectId], plan.proposedValue)
    else if (plan.kind === "withdraw") withdraw(plan.objectId)
    else if (plan.reason) setError(plan.reason)
  }

  const activeCard = draggingId ? cardsById.get(draggingId) : null

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ZoneKey />
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Scroll columns left"
              onClick={() => scrollColumns(-1)}
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Scroll columns right"
              onClick={() => scrollColumns(1)}
            >
              <ChevronRight />
            </Button>
          </div>
        {canProposeNewEntries && (
          <ProposeNewEntryButton
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            roundId={round.id}
            options={factor.options}
          />
        )}
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-md bg-surface-panel px-3 py-2 text-xs text-text-primary ring-1 ring-border-default"
        >
          {error}
        </p>
      )}

      <DndContext
        /*
          Explicit id: without one dnd-kit names its screen-reader description
          element from a module-level counter, which differs between server and
          client and causes a hydration mismatch. useId() is stable across both
          passes and unique per instance. __tests__/dnd-context-ids.test.tsx
          enforces this repo-wide.
        */
        id={dndContextId}
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <Board label={`${factor.name} card sort`} className="min-h-0 flex-1 items-stretch md:snap-none">
          {columns.map((column) => (
            <KanbanColumnView
              key={column.id}
              column={column}
              ctx={ctx}
              entries={entriesByColumn.get(column.value) ?? []}
              entryProps={entryProps}
            />
          ))}
        </Board>

        <DragOverlay>
          {activeCard ? (
            <div className="w-72 rotate-1 rounded-xl border border-border-interactive bg-surface-card p-3 text-sm font-semibold shadow-[var(--shadow-panel)]">
              {activeCard.title}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  )
}
