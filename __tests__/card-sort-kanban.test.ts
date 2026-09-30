import { describe, it, expect } from "vitest"
import {
  NO_VALUE_COLUMN_VALUE,
  buildKanbanColumns,
  planCardDrop,
  type KanbanProposal,
  type KanbanRow,
} from "@/lib/card-sort-kanban"
import type { SelectOption } from "@/lib/types"

/**
 * The kanban view's pure half: which cards land in which column and zone, and
 * what a drop is allowed to do.
 *
 * The drop planner is tested hard because it is the only place that decides what
 * a drag means, and the feature's central promise is that a drag never writes
 * the official custom field value. That promise is structural here — CardDropPlan
 * has no variant that could express "set the official value" — and the test at
 * the bottom of this file pins the union so nobody can quietly add one.
 */

const MOSCOW: SelectOption[] = [
  { label: "Must Do", value: "must_do_(contractually_obligated)" },
  { label: "Should Do", value: "should_do_(top_strategic_initiative)" },
  { label: "Could Do", value: "could_do_(nice_to_have)" },
]

const MUST = "must_do_(contractually_obligated)"
const SHOULD = "should_do_(top_strategic_initiative)"
const COULD = "could_do_(nice_to_have)"

const ROWS: KanbanRow[] = [
  { objectId: "obj-a", title: "Rate table redesign", currentValue: MUST },
  { objectId: "obj-b", title: "Savings hub", currentValue: SHOULD },
  { objectId: "obj-c", title: "Never sorted", currentValue: null },
]

function proposal(
  objectId: string,
  userName: string,
  proposedValue: string,
  overrides: Partial<KanbanProposal> = {}
): KanbanProposal {
  return {
    objectId,
    userId: `user-${userName}`,
    userName,
    proposedValue,
    fromValue: null,
    rationale: null,
    isMine: false,
    ...overrides,
  }
}

/** A proposal by the viewer. At most one per object, per the unique constraint. */
function mine(objectId: string, proposedValue: string, overrides: Partial<KanbanProposal> = {}) {
  return proposal(objectId, "rick", proposedValue, { isMine: true, ...overrides })
}

function build(proposals: KanbanProposal[] = [], rows: KanbanRow[] = ROWS) {
  return buildKanbanColumns({ options: MOSCOW, rows, proposals })
}

describe("buildKanbanColumns", () => {
  it("makes one column per effective option, in the field's own order", () => {
    const columns = build()
    // Option order, not alphabetical: a MoSCoW field is ordered by intent.
    expect(columns.slice(0, 3).map((column) => column.value)).toEqual([MUST, SHOULD, COULD])
    expect(columns.slice(0, 3).map((column) => column.label)).toEqual([
      "Must Do",
      "Should Do",
      "Could Do",
    ])
  })

  it("adds a (No value) column last and puts unset objects in it", () => {
    const columns = build()
    const last = columns.at(-1)!
    expect(last.value).toBe(NO_VALUE_COLUMN_VALUE)
    expect(last.cards.map((card) => card.objectId)).toEqual(["obj-c"])
  })

  it("gives every column a distinct id that does not encode the option value", () => {
    // Option values are free text up to 255 chars, so a delimiter-joined dnd id
    // could collide two columns into one. Ids are positional for that reason;
    // this asserts the value never leaks into the id.
    const columns = build()
    const ids = columns.map((column) => column.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const column of columns) {
      if (column.value) expect(column.id).not.toContain(column.value)
    }
  })

  it("files each object's solid card in its live official column", () => {
    const columns = build()
    expect(columns[0].cards.map((card) => card.objectId)).toEqual(["obj-a"])
    expect(columns[1].cards.map((card) => card.objectId)).toEqual(["obj-b"])
    expect(columns[2].cards).toEqual([])
    expect(columns[0].cards[0].placement).toBe("official")
  })

  it("lands the viewer's own proposal in the target and leaves an outline behind", () => {
    // The crux of the design. The drag lands: the card the viewer moved looks like
    // a card, in the column they dropped it on, and the hole it left is the only
    // thing still marking where the value officially sits.
    const columns = build([mine("obj-a", COULD)])

    const could = columns[2]
    expect(could.cards.map((card) => card.objectId)).toEqual(["obj-a"])
    expect(could.cards[0].placement).toBe("proposed")
    // The card carries its unchanged official value, which is what lets the UI say
    // "officially in Must Do" on a card sitting in the Could Do column.
    expect(could.cards[0].currentValue).toBe(MUST)
    expect(could.cards[0].currentLabel).toBe("Must Do")
    expect(could.incoming).toEqual([])

    const must = columns[0]
    expect(must.cards).toEqual([])
    expect(must.vacated.map((slot) => slot.objectId)).toEqual(["obj-a"])
    expect(must.vacated[0].movedToLabel).toBe("Could Do")
  })

  it("renders another user's proposal as a marker, never as a solid card", () => {
    // One object can have several rival destinations once a round is revealed, so
    // somebody else's proposal cannot be solid in the target — there is no single
    // target. The viewer's own card stays exactly where it officially is.
    const columns = build([proposal("obj-a", "dana", COULD)])

    const could = columns[2]
    expect(could.cards).toEqual([])
    expect(could.incoming.map((marker) => marker.objectId)).toEqual(["obj-a"])

    const must = columns[0]
    expect(must.cards.map((card) => card.objectId)).toEqual(["obj-a"])
    expect(must.cards[0].placement).toBe("official")
    // Nothing was vacated: the viewer did not move it, so there is no hole.
    expect(must.vacated).toEqual([])
  })

  it("counts official membership from live values, never from the cards rendered", () => {
    // The header must not lie. Landing a card in Could Do does not give Could Do a
    // member, and does not take Must Do's away — only a CustomFieldValue write
    // could do either, and nothing here writes one.
    const columns = build([mine("obj-a", COULD)])

    expect(columns[0].officialCount).toBe(1)
    expect(columns[0].cards).toHaveLength(0)

    expect(columns[2].officialCount).toBe(0)
    expect(columns[2].cards).toHaveLength(1)

    // Every object is counted once across the board, in its live column.
    expect(columns.reduce((total, column) => total + column.officialCount, 0)).toBe(ROWS.length)
  })

  it("labels a marker with its origin column and the number of other proposers", () => {
    const columns = build([
      proposal("obj-a", "dana", COULD),
      proposal("obj-a", "sam", COULD),
      mine("obj-a", COULD),
    ])
    const marker = columns[2].incoming[0]

    expect(marker.fromLabel).toBe("Must Do")
    // Two, not three: the viewer's own is the solid card sitting next to it, and
    // counting it here would double-count the viewer's opinion.
    expect(marker.proposerCount).toBe(2)
    expect(marker.proposers.map((p) => p.userName)).toEqual(["dana", "sam"])
    expect(columns[2].cards.map((card) => card.objectId)).toEqual(["obj-a"])
  })

  it("splits other people's rival targets into separate markers", () => {
    const columns = build([proposal("obj-a", "dana", COULD), proposal("obj-a", "sam", SHOULD)])
    expect(columns[1].incoming.map((m) => m.objectId)).toEqual(["obj-a"])
    expect(columns[2].incoming.map((m) => m.objectId)).toEqual(["obj-a"])
    // The solid card advertises both, most-proposed first then value order.
    expect(columns[0].cards[0].othersProposedTo.map((t) => t.value)).toEqual([SHOULD, COULD])
  })

  it("leaves the viewer's own target off the solid card's badges", () => {
    // Position already says where the viewer put it. A badge repeating it would be
    // the same fact twice, and on an OPEN round it would be the only fact there.
    const columns = build([mine("obj-a", COULD), proposal("obj-a", "dana", SHOULD)])
    const card = columns[2].cards[0]
    expect(card.myProposedValue).toBe(COULD)
    expect(card.othersProposedTo.map((t) => t.value)).toEqual([SHOULD])
  })

  it("lands an unset object's own proposal and vacates the (No value) column", () => {
    const columns = build([mine("obj-c", MUST)])
    // Residents before landings, so the top of a column is what is actually in it.
    expect(columns[0].cards.map((c) => c.objectId)).toEqual(["obj-a", "obj-c"])
    expect(columns[0].cards.map((c) => c.placement)).toEqual(["official", "proposed"])
    expect(columns[0].cards[1].currentLabel).toBe("(No value)")
    expect(columns.at(-1)!.cards).toEqual([])
    expect(columns.at(-1)!.vacated.map((s) => s.objectId)).toEqual(["obj-c"])
    expect(columns.at(-1)!.officialCount).toBe(1)
  })

  it("records the caller's own target on the solid card so withdraw can be offered", () => {
    const columns = build([mine("obj-a", COULD), proposal("obj-b", "dana", MUST)])
    expect(columns[2].cards[0].myProposedValue).toBe(COULD)
    // obj-b has a proposal, but not the caller's, so there is nothing to withdraw.
    expect(columns[1].cards[0].myProposedValue).toBeNull()
  })

  it("treats a proposal naming the value the object already has as no move at all", () => {
    // Reachable without any client bug: a facilitator reconciling the official
    // value to what somebody proposed turns a live proposal into a no-op. There is
    // nothing to land and no hole to leave, but withdraw is still the viewer's.
    const columns = build([mine("obj-a", MUST)])
    expect(columns[0].cards.map((c) => c.objectId)).toEqual(["obj-a"])
    expect(columns[0].cards[0].placement).toBe("official")
    expect(columns[0].cards[0].myProposedValue).toBe(MUST)
    expect(columns.flatMap((c) => c.vacated)).toEqual([])
  })

  it("carries rationales onto the marker so the drill-in has something to show", () => {
    const columns = build([
      proposal("obj-a", "dana", COULD, { rationale: "no contract behind it" }),
    ])
    expect(columns[2].incoming[0].proposers[0].rationale).toBe("no contract behind it")
  })

  it("never drops an object whose official value is not a declared option", () => {
    // A value removed from a shared option set still has objects sitting on it.
    // Dropping them would make cards silently vanish from the board.
    const columns = build([], [
      { objectId: "obj-x", title: "On a retired option", currentValue: "retired_option" },
    ])
    const stale = columns.find((column) => column.value === "retired_option")
    expect(stale).toBeDefined()
    expect(stale!.cards.map((c) => c.objectId)).toEqual(["obj-x"])
    // Appended after the declared options, before (No value).
    expect(columns.map((c) => c.value)).toEqual([
      MUST,
      SHOULD,
      COULD,
      "retired_option",
      NO_VALUE_COLUMN_VALUE,
    ])
  })

  it("puts every row on the board exactly once as a solid card, wherever it landed", () => {
    // The property the inversion has to preserve: a reader scanning the board sees
    // each object once. No duplicates, no losses, whatever the proposals say.
    const columns = build([mine("obj-a", COULD), proposal("obj-b", "sam", MUST)])
    const solids = columns.flatMap((column) => column.cards.map((card) => card.objectId))
    expect(solids.sort()).toEqual(["obj-a", "obj-b", "obj-c"])
  })
})

describe("planCardDrop", () => {
  const card = { objectId: "obj-a", currentValue: MUST, myProposedValue: null }

  it("proposes the target column's value when a card lands somewhere new", () => {
    expect(
      planCardDrop({ card, targetValue: COULD, roundState: "OPEN" })
    ).toEqual({ kind: "propose", objectId: "obj-a", proposedValue: COULD })
  })

  it("withdraws when a card with a proposal is dragged back to its own column", () => {
    expect(
      planCardDrop({
        card: { ...card, myProposedValue: COULD },
        targetValue: MUST,
        roundState: "OPEN",
      })
    ).toEqual({ kind: "withdraw", objectId: "obj-a" })
  })

  it("does nothing when a card with no proposal is dropped back where it started", () => {
    const plan = planCardDrop({ card, targetValue: MUST, roundState: "OPEN" })
    expect(plan.kind).toBe("noop")
  })

  it("does nothing when the card is dropped on the target it already proposes", () => {
    const plan = planCardDrop({
      card: { ...card, myProposedValue: COULD },
      targetValue: COULD,
      roundState: "OPEN",
    })
    expect(plan.kind).toBe("noop")
  })

  it("refuses to propose into the (No value) column and says why", () => {
    // There is no option to propose, so the API would reject it. Refusing here
    // with a readable reason beats a round trip that 400s.
    const plan = planCardDrop({ card, targetValue: NO_VALUE_COLUMN_VALUE, roundState: "OPEN" })
    expect(plan.kind).toBe("noop")
    expect(plan.kind === "noop" && plan.reason).toMatch(/no option/i)
  })

  it("still withdraws an unset object's proposal dropped back onto (No value)", () => {
    expect(
      planCardDrop({
        card: { objectId: "obj-c", currentValue: null, myProposedValue: MUST },
        targetValue: NO_VALUE_COLUMN_VALUE,
        roundState: "OPEN",
      })
    ).toEqual({ kind: "withdraw", objectId: "obj-c" })
  })

  for (const state of ["REVEALED", "CLOSED"] as const) {
    it(`refuses every drop while the round is ${state}`, () => {
      const plan = planCardDrop({ card, targetValue: COULD, roundState: state })
      expect(plan.kind).toBe("noop")
      expect(plan.kind === "noop" && plan.reason).toMatch(new RegExp(state, "i"))
    })

    it(`refuses to withdraw while the round is ${state}`, () => {
      const plan = planCardDrop({
        card: { ...card, myProposedValue: COULD },
        targetValue: MUST,
        roundState: state,
      })
      expect(plan.kind).toBe("noop")
    })
  }

  it("can only ever propose, withdraw, or do nothing — never write the official value", () => {
    /**
     * The invariant, asserted against the planner's whole output space rather
     * than one example. Every combination of official value, own proposal,
     * target column and round state is enumerated, and the only `kind`s that
     * may appear are propose/withdraw/noop. A future "move" or "setValue"
     * branch that mutates CustomFieldValue fails here on the first iteration.
     */
    const values = [MUST, SHOULD, COULD, null]
    const targets = [MUST, SHOULD, COULD, NO_VALUE_COLUMN_VALUE]
    const states = ["OPEN", "REVEALED", "CLOSED"] as const
    const kinds = new Set<string>()

    for (const currentValue of values) {
      for (const myProposedValue of values) {
        for (const targetValue of targets) {
          for (const roundState of states) {
            const plan = planCardDrop({
              card: { objectId: "obj-a", currentValue, myProposedValue },
              targetValue,
              roundState,
            })
            kinds.add(plan.kind)
            if (plan.kind === "propose") {
              // A propose never names the column the card already sits in, and
              // never names the no-value sentinel — both would be rejected by
              // the server as a no-op or an invalid option.
              expect(plan.proposedValue).not.toBe(currentValue)
              expect(plan.proposedValue).not.toBe(NO_VALUE_COLUMN_VALUE)
            }
          }
        }
      }
    }

    expect([...kinds].sort()).toEqual(["noop", "propose", "withdraw"])
  })
})
