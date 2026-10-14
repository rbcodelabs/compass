import type { SelectOption } from "@/lib/types"

/**
 * The kanban view's pure half: arranging cards into columns and zones, and
 * deciding what a drop means. No React, no fetch, no Prisma — so both halves are
 * testable without a DOM, and the drop rules can be enumerated exhaustively.
 *
 * ── The invariant this module exists to make structural ─────────────────────
 *
 * A drag NEVER writes the official CustomFieldValue. The whole point of a card
 * sort round is that proposals are non-destructive: the official value is read
 * only, and the round's output is a set of deltas a facilitator can act on or
 * discard.
 *
 * That is enforced here by the shape of `CardDropPlan`, which has exactly three
 * variants — propose, withdraw, noop — and no way to express "set the official
 * value". `planCardDrop` is the only thing that interprets a drop, so if the
 * union cannot say it, the UI cannot do it. The alternative (a component that
 * decides inline and calls whichever endpoint) is how
 * components/discovery/opportunity-board.tsx ends up mutating on drop, which is
 * correct there and forbidden here.
 *
 * ── Why columns are generic ─────────────────────────────────────────────────
 *
 * Columns are the round factor's effective options, whatever those happen to be.
 * Nothing here knows about MoSCoW, or status, or any particular field. A round
 * can be run on any SELECT custom field, including one whose options are
 * inherited from a SharedFieldOptionSet, and this module never branches on what
 * the options mean.
 */

/**
 * The "no value" column's value, spelled out so call sites read as intent rather
 * than as a bare null.
 *
 * It is `null` rather than a magic string on purpose: option values are free
 * text up to 255 characters, so ANY sentinel string could in principle be a real
 * option and collide two columns into one. null cannot. (Same reasoning as the
 * JSON.stringify edge key in lib/card-sort-tally.ts.)
 */
export const NO_VALUE_COLUMN_VALUE = null

/** Heading for the column holding objects with no value for the factor. */
export const NO_VALUE_COLUMN_LABEL = "(No value)"

/** An object on the board, with its live official value. */
export type KanbanRow = {
  objectId: string
  title: string
  /** The live CustomFieldValue. Read only in this view — never written. */
  currentValue: string | null
}

/**
 * A proposal the caller is allowed to see.
 *
 * Whether other people's proposals are in this list at all is decided on the
 * server by canSeeOtherProposals (OPEN → only your own; REVEALED/CLOSED →
 * everyone's). This module renders whatever it is given and makes no
 * authorization decision of its own — moving that gate client-side would put the
 * blind-vote guarantee in the browser, where the participant could read past it.
 */
export type KanbanProposal = {
  objectId: string
  userId: string
  userName: string
  /** The option value this proposal moves the object TO. */
  proposedValue: string
  /** The official value when the proposal was made; null = object was unset. */
  fromValue: string | null
  rationale: string | null
  /** True when the caller made this proposal. Drives the withdraw affordance. */
  isMine: boolean
}

/**
 * A solid card — the thing that looks like a card.
 *
 * Exactly one of these exists per row, and `placement` says why it is in the
 * column it is in:
 *
 * - `"official"` — the card sits in its live value's column. Nothing proposed,
 *   or the viewer's own proposal happens to name the value it already has.
 * - `"proposed"` — the VIEWER dragged it here. The drag landed: this is where
 *   they put it, and the column it came from holds a VacatedSlot instead.
 *
 * `placement: "proposed"` is only ever the viewer's own proposal, never someone
 * else's. That is not a style choice — after a reveal, three people can propose
 * three different destinations for one object, and a card cannot be solid in
 * three columns at once. The unique constraint on (round, user, object) is what
 * makes "solid in the target" unambiguous for your own, and other people's
 * arrive as IncomingMarker instead.
 */
export type PlacedCard = {
  objectId: string
  title: string
  /**
   * The live CustomFieldValue. Unchanged by any proposal — a card rendered in a
   * column other than this one has still not moved in the database, and this
   * field is how the UI says so.
   */
  currentValue: string | null
  currentLabel: string
  placement: "official" | "proposed"
  /** The caller's own target, if any. Non-null means withdraw is available. */
  myProposedValue: string | null
  /**
   * OTHER people's targets for this object, most-proposed first. The viewer's own
   * is deliberately absent: position already says where they put it, and a badge
   * repeating it would be the same fact twice.
   */
  othersProposedTo: { value: string; label: string; count: number }[]
}

/**
 * The hole a card left behind: this object is officially in this column, and the
 * viewer has proposed moving it out.
 *
 * This is the ghost. It carries no action — withdraw lives on the solid card,
 * where the reader is already looking — so it renders as static text and must
 * not be focusable. A focus stop that does nothing is noise on a board that
 * already has two per card.
 */
export type VacatedSlot = {
  objectId: string
  title: string
  /** Where the viewer proposed sending it. */
  movedToValue: string
  movedToLabel: string
}

/**
 * Somebody ELSE proposed moving this object into this column.
 *
 * Deliberately lightweight, not a solid card: see the note on PlacedCard about
 * one object having several rival destinations. The aggregate story — who is
 * pulling what, and how hard — is the flow-arrow tally's job, so this says only
 * enough to be recognizable and offers a drill-in for the rest.
 */
export type IncomingMarker = {
  objectId: string
  title: string
  /**
   * Where the object officially is now — NOT the proposal's stored `fromValue`.
   * Those differ once a facilitator reconciles a value, and the marker has to
   * agree with where the solid card is actually rendered or the pair reads as a
   * contradiction. `fromValue` is still the right basis for flow arithmetic,
   * which is why lib/card-sort-tally.ts uses it and this does not.
   */
  fromValue: string | null
  fromLabel: string
  /** How many OTHER people proposed this exact move. Never counts the viewer. */
  proposerCount: number
  proposers: { userId: string; userName: string; rationale: string | null }[]
}

export type KanbanColumn = {
  /**
   * Positional, not value-derived. dnd-kit ids are strings, and building one by
   * joining an option value to a prefix would be ambiguous for free-text values.
   * Position is unique by construction.
   */
  id: string
  /** The option value this column represents; NO_VALUE_COLUMN_VALUE for unset. */
  value: string | null
  label: string
  /**
   * How many objects actually hold this value, whatever is rendered here.
   *
   * Kept separate from `cards.length` on purpose. Once the viewer's own proposal
   * moves a solid card into its target column, counting the cards in a column
   * would report that column as having members it does not have — the header
   * would be asserting a change to CustomFieldValue that nobody has made. This
   * number is derived only from live values, so it cannot drift from the
   * database no matter how the board is arranged.
   */
  officialCount: number
  /** Solid cards rendered here: residents, plus the viewer's own landings. */
  cards: PlacedCard[]
  /** Outlines for objects officially here that the viewer has proposed moving out. */
  vacated: VacatedSlot[]
  /** Other people's proposals into this column. */
  incoming: IncomingMarker[]
}

/**
 * Arranges rows and visible proposals into columns.
 *
 * ── Where a card goes, and what it leaves behind ────────────────────────────
 *
 * The drag lands. A card the viewer proposed moving renders as a solid card in
 * the TARGET column — where they put it — and the column it officially belongs
 * to shows a VacatedSlot outline in its place. The hole is what keeps official
 * state legible: something is visibly missing from the column that still owns
 * it, rather than the column looking untouched while a copy sits elsewhere.
 *
 * Every row still yields exactly one solid card. That is the property worth
 * holding onto — a reader scanning the board sees each object once, and
 * `officialCount` rather than `cards.length` is what reports membership, so
 * moving a card never makes the header claim a value nobody set.
 *
 * Other people's proposals cannot use this arrangement, because one object can
 * have several rival destinations and a card cannot be solid in more than one
 * column. They arrive as IncomingMarker — a distinct, lighter treatment, so
 * "where I put it" and "where somebody else wants it" are told apart at a glance
 * without hovering.
 *
 * ── Column order ───────────────────────────────────────────────────────────
 *
 * The field's own option order, then any values that appear in the data but are
 * no longer declared options, then the no-value column. Stale values get a
 * column rather than being dropped: an option removed from a shared set still
 * has objects sitting on it, and silently omitting them would make cards vanish
 * from the board with no indication that anything is missing. The no-value
 * column goes last to match how the table view sorts unset rows.
 */
export function buildKanbanColumns({
  options,
  rows,
  proposals,
}: {
  options: readonly SelectOption[]
  rows: readonly KanbanRow[]
  proposals: readonly KanbanProposal[]
}): KanbanColumn[] {
  const labels = new Map(options.map((option) => [option.value, option.label]))
  const optionOrder = new Map(options.map((option, index) => [option.value, index]))
  const labelFor = (value: string | null) =>
    value === null ? NO_VALUE_COLUMN_LABEL : labels.get(value) ?? value

  // Declared options first, then anything the data references but the field no
  // longer declares.
  const columnValues: (string | null)[] = options.map((option) => option.value)
  const seen = new Set<string>(columnValues as string[])
  const noteValue = (value: string | null) => {
    if (value !== null && !seen.has(value)) {
      seen.add(value)
      columnValues.push(value)
    }
  }
  for (const row of rows) noteValue(row.currentValue)
  for (const proposal of proposals) noteValue(proposal.proposedValue)
  columnValues.push(NO_VALUE_COLUMN_VALUE)

  const byObject = new Map<string, KanbanProposal[]>()
  for (const proposal of proposals) {
    const list = byObject.get(proposal.objectId)
    if (list) list.push(proposal)
    else byObject.set(proposal.objectId, [proposal])
  }

  const rank = (value: string) => optionOrder.get(value) ?? Number.MAX_SAFE_INTEGER

  const officialCounts = new Map<string | null, number>()
  const cards = new Map<string | null, PlacedCard[]>()
  const vacated = new Map<string | null, VacatedSlot[]>()
  const incoming = new Map<string | null, IncomingMarker[]>()

  const push = <T>(into: Map<string | null, T[]>, key: string | null, item: T) => {
    const list = into.get(key)
    if (list) list.push(item)
    else into.set(key, [item])
  }

  for (const row of rows) {
    const all = byObject.get(row.objectId) ?? []
    // At most one, guaranteed by the unique constraint on (round, user, object).
    const mine = all.find((proposal) => proposal.isMine) ?? null
    const others = all.filter((proposal) => !proposal.isMine)

    // Official membership is counted from the live value alone, never from where
    // a card ends up rendered. See KanbanColumn.officialCount.
    officialCounts.set(row.currentValue, (officialCounts.get(row.currentValue) ?? 0) + 1)

    const othersByTarget = new Map<string, KanbanProposal[]>()
    for (const proposal of others) {
      const list = othersByTarget.get(proposal.proposedValue)
      if (list) list.push(proposal)
      else othersByTarget.set(proposal.proposedValue, [proposal])
    }

    const othersProposedTo = [...othersByTarget.entries()]
      .map(([value, group]) => ({ value, label: labelFor(value), count: group.length }))
      // Most-proposed first, then the field's own option order. The tally breaks
      // ties alphabetically; here column order is what the reader can see, so
      // matching it is less surprising than an alphabetical jumble.
      .sort((a, b) => b.count - a.count || rank(a.value) - rank(b.value))

    const myTarget = mine?.proposedValue ?? null

    // A proposal naming the value the object already has is not a move, so there
    // is nothing to land and no hole to leave. It is reachable without any
    // client bug: a facilitator reconciling the official value to what somebody
    // proposed turns a live proposal into a no-op rather than deleting it.
    const landed = myTarget !== null && myTarget !== row.currentValue

    push(cards, landed ? myTarget : row.currentValue, {
      objectId: row.objectId,
      title: row.title,
      currentValue: row.currentValue,
      currentLabel: labelFor(row.currentValue),
      placement: landed ? "proposed" : "official",
      myProposedValue: myTarget,
      othersProposedTo,
    })

    if (landed) {
      push(vacated, row.currentValue, {
        objectId: row.objectId,
        title: row.title,
        movedToValue: myTarget,
        movedToLabel: labelFor(myTarget),
      })
    }

    for (const [value, group] of othersByTarget) {
      push(incoming, value, {
        objectId: row.objectId,
        title: row.title,
        fromValue: row.currentValue,
        fromLabel: labelFor(row.currentValue),
        proposerCount: group.length,
        proposers: group.map((proposal) => ({
          userId: proposal.userId,
          userName: proposal.userName,
          rationale: proposal.rationale,
        })),
      })
    }
  }

  return columnValues.map((value, index) => ({
    id: `card-sort-column-${index}`,
    value,
    label: labelFor(value),
    officialCount: officialCounts.get(value) ?? 0,
    // Residents before landings, so the top of a column is what is actually in
    // it and the viewer's own additions read as additions.
    cards: (cards.get(value) ?? []).sort(
      (a, b) => Number(a.placement === "proposed") - Number(b.placement === "proposed")
    ),
    vacated: vacated.get(value) ?? [],
    incoming: incoming.get(value) ?? [],
  }))
}

/**
 * What a drop is allowed to do. Three variants, none of which writes the
 * official value — see the invariant at the top of this file.
 */
export type CardDropPlan =
  | { kind: "propose"; objectId: string; proposedValue: string }
  | { kind: "withdraw"; objectId: string }
  /** Nothing to do. `reason` is non-null only when the user deserves an explanation. */
  | { kind: "noop"; reason: string | null }

/**
 * Interprets dropping one card on one column.
 *
 * Dropping onto a different column proposes that column's value; dropping back
 * onto the card's own column withdraws the caller's proposal, which is the
 * gesture-level inverse and means undo needs no separate control (though the
 * ghost carries one too, because discovering undo-by-drag requires already
 * knowing it exists).
 *
 * Round state is checked here as well as on the server. That is not a substitute
 * for the server check — lib/card-sort.ts is still the authority, and a forged
 * request on a CLOSED round is rejected there — it is so the UI can disable drag
 * and explain why instead of letting a gesture fail silently.
 */
export function planCardDrop({
  card,
  targetValue,
  roundState,
}: {
  card: { objectId: string; currentValue: string | null; myProposedValue: string | null }
  targetValue: string | null
  roundState: "OPEN" | "REVEALED" | "CLOSED"
}): CardDropPlan {
  if (roundState !== "OPEN") {
    return {
      kind: "noop",
      reason: `This round is ${roundState}, so proposals are frozen.`,
    }
  }

  // Back to its own column: take the proposal back, or do nothing if there was
  // none to take back.
  if (targetValue === card.currentValue) {
    return card.myProposedValue === null
      ? { kind: "noop", reason: null }
      : { kind: "withdraw", objectId: card.objectId }
  }

  // The no-value column names no option, so there is nothing to propose. The
  // server would reject it; refusing here gives a readable reason instead of a
  // 400 the user has to interpret.
  if (targetValue === NO_VALUE_COLUMN_VALUE) {
    return {
      kind: "noop",
      reason: "There is no option to propose — drag onto a named column instead.",
    }
  }

  // Already proposed exactly this. The server's upsert would happily rewrite the
  // same row, but a request that changes nothing is not worth making.
  if (targetValue === card.myProposedValue) return { kind: "noop", reason: null }

  return { kind: "propose", objectId: card.objectId, proposedValue: targetValue }
}
