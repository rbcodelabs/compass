/**
 * Unit tests for the card sort MCP tool handlers.
 *
 * The service layer (lib/card-sort) is mocked: its rules — factor validation,
 * fromValue snapshotting, the hidden-until-REVEALED gate — are covered against a
 * real database by __tests__/card-sort-*.integration.test.ts. What is under test
 * here is the thin shell: acting-identity handling, CardSortError -> tool
 * failure translation, argument forwarding, and the response format.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const service = vi.hoisted(() => ({
  createCardSortRound: vi.fn(),
  getCardSortTally: vi.fn(),
  listCardSortFactors: vi.fn(),
  listCardSortRounds: vi.fn(),
  listMyCardSortProposals: vi.fn(),
  loadCardSortBoard: vi.fn(),
  proposeCardSortMoves: vi.fn(),
  setCardSortRoundState: vi.fn(),
  withdrawCardSortProposal: vi.fn(),
}))

// Keep the real CardSortError so the handler's `instanceof` check is exercised.
vi.mock("@/lib/card-sort", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/card-sort")>()),
  ...service,
}))

import { CardSortError } from "@/lib/card-sort"
import { McpAuthzError, runWithMcpActor } from "@/lib/mcp-authz"
import {
  createCardSortRoundTool,
  getCardSortBoardTool,
  getCardSortProposalsTool,
  getCardSortTallyTool,
  listCardSortFactorsTool,
  listCardSortRoundsTool,
  proposeCardSortMoveTool,
  setCardSortRoundStateTool,
  withdrawCardSortProposalTool,
} from "@/lib/card-sort-tool-handlers"

const WS = "11111111-1111-4111-8111-111111111111"
const ROUND = "22222222-2222-4222-8222-222222222222"
const FIELD = "33333333-3333-4333-8333-333333333333"
const OBJ_A = "44444444-4444-4444-8444-444444444444"
const OBJ_B = "55555555-5555-4555-8555-555555555555"
const USER = "user-1"

const UUID_ID_LINE = /^ID: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/m

const asPerson = <T>(fn: () => Promise<T>) => runWithMcpActor({ userId: USER }, fn)
const asServiceKey = <T>(fn: () => Promise<T>) =>
  runWithMcpActor({ userId: null, purpose: "SERVICE" }, fn)

const text = (result: { content: { text: string }[] }) => result.content[0].text

function roundSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: ROUND,
    name: "Q4 prioritisation",
    objectType: "OPPORTUNITY",
    fieldDefinitionId: FIELD,
    factorName: "Priority",
    state: "OPEN",
    createdById: USER,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    revealedAt: null,
    closedAt: null,
    proposalCount: 0,
    myProposalCount: 0,
    ...overrides,
  }
}

beforeEach(() => vi.resetAllMocks())

describe("acting identity", () => {
  // A proposal is one named person's opinion; the shared service key has no
  // person, so every tool must refuse rather than invent an author.
  it.each([
    ["create_card_sort_round", () => createCardSortRoundTool({ workspaceId: WS, name: "x", fieldDefinitionId: FIELD })],
    ["list_card_sort_rounds", () => listCardSortRoundsTool({ workspaceId: WS })],
    ["set_card_sort_round_state", () => setCardSortRoundStateTool({ workspaceId: WS, roundId: ROUND, state: "REVEALED" })],
    ["propose_card_sort_move", () => proposeCardSortMoveTool({ workspaceId: WS, roundId: ROUND, objectIds: [OBJ_A], proposedValue: "Must" })],
    ["withdraw_card_sort_proposal", () => withdrawCardSortProposalTool({ workspaceId: WS, roundId: ROUND, objectId: OBJ_A })],
    ["get_card_sort_proposals", () => getCardSortProposalsTool({ workspaceId: WS, roundId: ROUND })],
    ["get_card_sort_board", () => getCardSortBoardTool({ workspaceId: WS, roundId: ROUND })],
    ["get_card_sort_tally", () => getCardSortTallyTool({ workspaceId: WS, roundId: ROUND })],
  ])("%s rejects the shared service key and never reaches the service layer", async (_name, call) => {
    await expect(asServiceKey(call)).rejects.toThrow(McpAuthzError)
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled()
  })

  it("throws when called outside an authorization scope", async () => {
    await expect(listCardSortRoundsTool({ workspaceId: WS })).rejects.toThrow(/Authorization context is missing/)
  })
})

describe("listCardSortFactorsTool", () => {
  it("lists each factor with its buckets and option source", async () => {
    service.listCardSortFactors.mockResolvedValue([
      {
        id: FIELD, name: "Priority", objectType: "OPPORTUNITY", sharedOptionSetName: null,
        options: [{ value: "must", label: "Must" }, { value: "should", label: "Should" }],
      },
      {
        id: "f2", name: "Risk", objectType: "OPPORTUNITY", sharedOptionSetName: "Levels",
        options: [{ value: "hi", label: "High" }],
      },
    ])

    const result = await asPerson(() => listCardSortFactorsTool({ workspaceId: WS, objectType: "OPPORTUNITY" }))

    expect(service.listCardSortFactors).toHaveBeenCalledWith({ workspaceId: WS, objectType: "OPPORTUNITY" })
    expect(text(result)).toContain(`Priority (${FIELD}): 2 buckets from its own options — Must, Should`)
    expect(text(result)).toContain('shared option set "Levels"')
    expect(result.structuredContent).toMatchObject({ ok: true, data: { count: 2 } })
  })

  it("explains what makes a valid factor when there are none", async () => {
    service.listCardSortFactors.mockResolvedValue([])

    const result = await listCardSortFactorsTool({ workspaceId: WS, objectType: "SOLUTION" })

    expect(text(result)).toContain("No SELECT custom fields on SOLUTION")
    expect(result.structuredContent).toMatchObject({ ok: true, data: { items: [], count: 0 } })
  })
})

describe("createCardSortRoundTool", () => {
  it("creates a round attributed to the acting user and reports its ID on its own line", async () => {
    service.createCardSortRound.mockResolvedValue(roundSummary())

    const result = await asPerson(() =>
      createCardSortRoundTool({ workspaceId: WS, name: "Q4 prioritisation", fieldDefinitionId: FIELD })
    )

    expect(service.createCardSortRound).toHaveBeenCalledWith({
      workspaceId: WS, userId: USER, name: "Q4 prioritisation", fieldDefinitionId: FIELD,
    })
    expect(text(result)).toContain('Created card sort round "Q4 prioritisation" on Priority.')
    expect(text(result)).toContain("OPEN")
    expect(text(result)).toContain(`ID: ${ROUND}`)
    expect(text(result)).toMatch(UUID_ID_LINE)
    expect(result.structuredContent).toMatchObject({ ok: true, data: { id: ROUND } })
  })

  it("reports a CardSortError as a tool failure rather than throwing", async () => {
    service.createCardSortRound.mockRejectedValue(
      new CardSortError("INVALID_FACTOR", "That field cannot be used as a factor.")
    )

    const result = await asPerson(() =>
      createCardSortRoundTool({ workspaceId: WS, name: "x", fieldDefinitionId: FIELD })
    )

    expect(text(result)).toBe("That field cannot be used as a factor.")
    expect(result.structuredContent).toMatchObject({ ok: false, data: null })
  })

  it("rethrows unexpected errors instead of disguising them as tool failures", async () => {
    service.createCardSortRound.mockRejectedValue(new Error("connection reset"))

    await expect(
      asPerson(() => createCardSortRoundTool({ workspaceId: WS, name: "x", fieldDefinitionId: FIELD }))
    ).rejects.toThrow("connection reset")
  })
})

describe("listCardSortRoundsTool", () => {
  it("lists rounds and forwards the state filter", async () => {
    service.listCardSortRounds.mockResolvedValue([
      roundSummary({ proposalCount: 4, myProposalCount: 2, state: "REVEALED" }),
    ])

    const result = await asPerson(() => listCardSortRoundsTool({ workspaceId: WS, state: "REVEALED" }))

    expect(service.listCardSortRounds).toHaveBeenCalledWith({ workspaceId: WS, userId: USER, state: "REVEALED" })
    expect(text(result)).toContain(`Q4 prioritisation (${ROUND}): REVEALED, factor Priority, 4 proposal(s) total, 2 from you`)
    expect(result.structuredContent).toMatchObject({ data: { count: 1 } })
  })

  it("does not print a total for a round whose count is hidden", async () => {
    // null means "not permitted to know yet" — printing 0 would be a false answer.
    service.listCardSortRounds.mockResolvedValue([roundSummary({ proposalCount: null, myProposalCount: 1 })])

    const result = await asPerson(() => listCardSortRoundsTool({ workspaceId: WS }))

    expect(text(result)).toContain("total hidden until revealed")
    expect(text(result)).not.toContain("0 proposal(s) total")
  })

  it("says so when there are no rounds", async () => {
    service.listCardSortRounds.mockResolvedValue([])

    const result = await asPerson(() => listCardSortRoundsTool({ workspaceId: WS }))

    expect(text(result)).toBe("No card sort rounds found.")
    expect(result.structuredContent).toMatchObject({ data: { items: [], count: 0 } })
  })
})

describe("setCardSortRoundStateTool", () => {
  it("reveals a round, warns it is irreversible, and reports the ID on its own line", async () => {
    service.setCardSortRoundState.mockResolvedValue({ id: ROUND, name: "Q4 prioritisation", state: "REVEALED" })

    const result = await asPerson(() =>
      setCardSortRoundStateTool({ workspaceId: WS, roundId: ROUND, state: "REVEALED" })
    )

    expect(service.setCardSortRoundState).toHaveBeenCalledWith({
      workspaceId: WS, roundId: ROUND, userId: USER, state: "REVEALED",
    })
    expect(text(result)).toContain('Round "Q4 prioritisation" is now REVEALED.')
    expect(text(result)).toContain("cannot be undone")
    expect(text(result)).toContain(`ID: ${ROUND}`)
    expect(text(result)).toMatch(UUID_ID_LINE)
  })

  it("closes a round with the no-further-proposals note", async () => {
    service.setCardSortRoundState.mockResolvedValue({ id: ROUND, name: "Q4 prioritisation", state: "CLOSED" })

    const result = await asPerson(() =>
      setCardSortRoundStateTool({ workspaceId: WS, roundId: ROUND, state: "CLOSED" })
    )

    expect(text(result)).toContain("is now CLOSED.")
    expect(text(result)).toContain("No further proposals will be accepted.")
    expect(text(result)).toMatch(UUID_ID_LINE)
  })

  it("reports a non-facilitator or wrong-state attempt as a failure", async () => {
    service.setCardSortRoundState.mockRejectedValue(new CardSortError("WRONG_STATE", "This round is already revealed."))

    const result = await asPerson(() =>
      setCardSortRoundStateTool({ workspaceId: WS, roundId: ROUND, state: "REVEALED" })
    )

    expect(text(result)).toBe("This round is already revealed.")
    expect(result.structuredContent).toMatchObject({ ok: false })
  })
})

describe("proposeCardSortMoveTool", () => {
  it("forwards the batch and defaults a missing rationale to null", async () => {
    service.proposeCardSortMoves.mockResolvedValue({ applied: [OBJ_A, OBJ_B], skipped: [] })

    const result = await asPerson(() =>
      proposeCardSortMoveTool({ workspaceId: WS, roundId: ROUND, objectIds: [OBJ_A, OBJ_B], proposedValue: "Must" })
    )

    expect(service.proposeCardSortMoves).toHaveBeenCalledWith({
      workspaceId: WS, roundId: ROUND, userId: USER,
      objectIds: [OBJ_A, OBJ_B], proposedValue: "Must", rationale: null,
    })
    expect(text(result)).toBe(`Recorded 2 proposal(s) to move to "Must".\nID: ${ROUND}`)
    expect(result.structuredContent).toMatchObject({ ok: true, data: { applied: [OBJ_A, OBJ_B] } })
  })

  it("passes a rationale through and lists skipped objects with their reason code", async () => {
    service.proposeCardSortMoves.mockResolvedValue({
      applied: [OBJ_A],
      skipped: [{ objectId: OBJ_B, code: "NO_OP", reason: "Already in Must." }],
    })

    const result = await asPerson(() =>
      proposeCardSortMoveTool({
        workspaceId: WS, roundId: ROUND, objectIds: [OBJ_A, OBJ_B], proposedValue: "Must", rationale: "Customer asks",
      })
    )

    expect(service.proposeCardSortMoves).toHaveBeenCalledWith(expect.objectContaining({ rationale: "Customer asks" }))
    expect(text(result)).toContain("Recorded 1 proposal(s)")
    expect(text(result)).toContain(`Skipped 1: ${OBJ_B} (NO_OP).`)
  })

  it("fails the call when the target value is not a valid bucket", async () => {
    service.proposeCardSortMoves.mockRejectedValue(new CardSortError("INVALID_VALUE", '"Nope" is not an option.'))

    const result = await asPerson(() =>
      proposeCardSortMoveTool({ workspaceId: WS, roundId: ROUND, objectIds: [OBJ_A], proposedValue: "Nope" })
    )

    expect(text(result)).toBe('"Nope" is not an option.')
    expect(result.structuredContent).toMatchObject({ ok: false })
  })
})

describe("withdrawCardSortProposalTool", () => {
  it("withdraws the caller's own proposal", async () => {
    service.withdrawCardSortProposal.mockResolvedValue({ withdrawn: 1 })

    const result = await asPerson(() =>
      withdrawCardSortProposalTool({ workspaceId: WS, roundId: ROUND, objectId: OBJ_A })
    )

    expect(service.withdrawCardSortProposal).toHaveBeenCalledWith({
      workspaceId: WS, roundId: ROUND, userId: USER, objectId: OBJ_A,
    })
    expect(text(result)).toContain("Withdrew your proposal.")
    expect(result.structuredContent).toMatchObject({ ok: true, data: { withdrawn: 1 } })
  })

  it("fails when the caller has no proposal on that object", async () => {
    service.withdrawCardSortProposal.mockRejectedValue(
      new CardSortError("NOT_FOUND", "You have no proposal on that object to withdraw.")
    )

    const result = await asPerson(() =>
      withdrawCardSortProposalTool({ workspaceId: WS, roundId: ROUND, objectId: OBJ_A })
    )

    expect(text(result)).toBe("You have no proposal on that object to withdraw.")
    expect(result.structuredContent).toMatchObject({ ok: false })
  })
})

describe("getCardSortProposalsTool", () => {
  it("lists the caller's proposals with from -> to and rationale", async () => {
    service.listMyCardSortProposals.mockResolvedValue([
      { objectId: OBJ_A, objectTitle: "Faster checkout", proposedValue: "Must", fromValue: "Should", rationale: "Blocks launch", updatedAt: new Date() },
      { objectId: OBJ_B, objectTitle: "Dark mode", proposedValue: "Should", fromValue: null, rationale: null, updatedAt: new Date() },
    ])

    const result = await asPerson(() => getCardSortProposalsTool({ workspaceId: WS, roundId: ROUND }))

    expect(service.listMyCardSortProposals).toHaveBeenCalledWith({ workspaceId: WS, roundId: ROUND, userId: USER })
    expect(text(result)).toContain("Your 2 proposal(s) in this round:")
    expect(text(result)).toContain("- Faster checkout: Should → Must — Blocks launch")
    expect(text(result)).toContain("- Dark mode: (unset) → Should")
    expect(result.structuredContent).toMatchObject({ data: { count: 2 } })
  })

  it("says so when the caller has proposed nothing", async () => {
    service.listMyCardSortProposals.mockResolvedValue([])

    const result = await asPerson(() => getCardSortProposalsTool({ workspaceId: WS, roundId: ROUND }))

    expect(text(result)).toBe("You have not proposed any moves in this round.")
  })

  it("fails for a round that is not in the workspace", async () => {
    service.listMyCardSortProposals.mockRejectedValue(new CardSortError("NOT_FOUND", "Round not found."))

    const result = await asPerson(() => getCardSortProposalsTool({ workspaceId: WS, roundId: ROUND }))

    expect(text(result)).toBe("Round not found.")
    expect(result.structuredContent).toMatchObject({ ok: false })
  })
})

describe("getCardSortBoardTool", () => {
  it("groups objects by current value and shows only the caller's own proposals", async () => {
    service.loadCardSortBoard.mockResolvedValue({
      round: roundSummary(),
      factor: { id: FIELD, name: "Priority", options: [] },
      rows: [
        { objectId: OBJ_A, title: "Faster checkout", currentValue: "Should", myProposedValue: "Must", myRationale: null },
        { objectId: OBJ_B, title: "Dark mode", currentValue: null, myProposedValue: null, myRationale: null },
      ],
      proposals: [],
      isFacilitator: true,
      canSeeTally: false,
    })

    const result = await asPerson(() => getCardSortBoardTool({ workspaceId: WS, roundId: ROUND }))

    expect(service.loadCardSortBoard).toHaveBeenCalledWith({ workspaceId: WS, roundId: ROUND, userId: USER })
    expect(text(result)).toContain('Round "Q4 prioritisation" on Priority, OPEN. 2 object(s)')
    expect(text(result)).toContain("Should (1):\n  Faster checkout [you propose → Must]")
    expect(text(result)).toContain("(unset) (1):\n  Dark mode")
  })

  it("fails for an unknown round", async () => {
    service.loadCardSortBoard.mockRejectedValue(new CardSortError("NOT_FOUND", "Round not found."))

    const result = await asPerson(() => getCardSortBoardTool({ workspaceId: WS, roundId: ROUND }))

    expect(result.structuredContent).toMatchObject({ ok: false, message: "Round not found." })
  })
})

describe("getCardSortTallyTool", () => {
  const tally = {
    round: { id: ROUND, name: "Q4 prioritisation", state: "REVEALED", factorName: "Priority" },
    options: [],
    objects: [
      {
        objectId: OBJ_A, title: "Faster checkout", currentValue: "Should",
        targets: [{ value: "Must", count: 2, proposers: [
          { userId: "u1", userName: "Ada", rationale: null },
          { userId: "u2", userName: "Grace", rationale: null },
        ] }],
        proposalCount: 2, distinctTargetCount: 1, unanimousMove: true,
      },
    ],
    contested: [
      {
        objectId: OBJ_A, title: "Faster checkout", currentValue: "Should", targets: [],
        proposalCount: 2, distinctTargetCount: 1, unanimousMove: true,
      },
    ],
    flow: {
      edges: [],
      buckets: [
        { value: "Must", inflow: 2, outflow: 0, net: 2 },
        { value: "Should", inflow: 0, outflow: 2, net: -2 },
        { value: "Could", inflow: 0, outflow: 0, net: 0 },
      ],
      fromUnsetCount: 0,
    },
    participantCount: 2,
    proposalCount: 2,
  }

  it("renders the revealed tally: proposers, net flow (skipping idle buckets) and the sparse-data caveat", async () => {
    service.getCardSortTally.mockResolvedValue(tally)

    const result = await asPerson(() => getCardSortTallyTool({ workspaceId: WS, roundId: ROUND }))

    expect(service.getCardSortTally).toHaveBeenCalledWith({ workspaceId: WS, roundId: ROUND, userId: USER })
    const out = text(result)
    expect(out).toContain("2 proposal(s) from 2 participant(s) across 1 object(s).")
    expect(out).toContain("- Faster checkout — currently Should → Must ×2 (Ada, Grace)")
    expect(out).toContain("Must: +2 / -0 = net 2")
    expect(out).toContain("Should: +0 / -2 = net -2")
    expect(out).not.toContain("Could:")
    expect(out).toContain("NOT that everyone agreed")
    expect(out).toContain("Faster checkout (1 different target(s) across 2 proposal(s))")
    expect(result.structuredContent).toMatchObject({ ok: true, data: { proposalCount: 2 } })
  })

  it("mentions proposals made on objects that had no current value", async () => {
    service.getCardSortTally.mockResolvedValue({ ...tally, flow: { ...tally.flow, fromUnsetCount: 3 } })

    const result = await asPerson(() => getCardSortTallyTool({ workspaceId: WS, roundId: ROUND }))

    expect(text(result)).toContain("3 proposal(s) came from objects with no current value.")
  })

  it("reports an empty revealed round", async () => {
    service.getCardSortTally.mockResolvedValue({ ...tally, objects: [], contested: [], proposalCount: 0, participantCount: 0 })

    const result = await asPerson(() => getCardSortTallyTool({ workspaceId: WS, roundId: ROUND }))

    expect(text(result)).toBe("Nobody has proposed a move in this round yet.")
    expect(result.structuredContent).toMatchObject({ ok: true, data: { items: [] } })
  })

  it("returns a failure, not the payload, while the round is still OPEN", async () => {
    service.getCardSortTally.mockRejectedValue(
      new CardSortError("HIDDEN_UNTIL_REVEALED", "The tally is hidden until the round is revealed.")
    )

    const result = await asPerson(() => getCardSortTallyTool({ workspaceId: WS, roundId: ROUND }))

    expect(text(result)).toBe("The tally is hidden until the round is revealed.")
    expect(result.structuredContent).toMatchObject({ ok: false, data: null })
  })
})
