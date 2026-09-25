import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/db", () => ({ default: vi.fn() }))
vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "user-1" } })) }))

import type { AppPrismaClient } from "@/lib/db"
import {
  OpportunityCreateError,
  createOpportunityWithLinks,
  normalizeNewOpportunityInput,
} from "@/lib/opportunity-create"

/**
 * A tiny in-memory stand-in for the four tables this write touches. Its
 * `$transaction` works on a copy and only commits the copy when the callback
 * resolves, so "nothing is created" can be asserted on real state rather than
 * on which mocks happened to be called.
 */
type Feedback = { id: string; workspaceId: string; opportunityId: string | null; updatedAt: Date; status: string }
type State = {
  opportunities: Array<Record<string, unknown> & { id: string }>
  feedback: Feedback[]
  squads: Array<{ id: string; workspaceId: string }>
  keyResults: Array<{ id: string; workspaceId: string }>
}

function makeDb(initial: State) {
  let state = structuredClone(initial)
  let seq = 0
  const client = (s: State) => ({
    squad: {
      findFirst: async ({ where }: { where: { id: string; workspaceId: string } }) =>
        s.squads.find((row) => row.id === where.id && row.workspaceId === where.workspaceId) ?? null,
    },
    keyResult: {
      findFirst: async ({ where }: { where: { id: string; objective: { cycle: { workspaceId: string } } } }) =>
        s.keyResults.find((row) => row.id === where.id && row.workspaceId === where.objective.cycle.workspaceId) ?? null,
    },
    feedbackItem: {
      findMany: async ({ where }: { where: { id: { in: string[] }; workspaceId: string } }) =>
        s.feedback.filter((row) => where.id.in.includes(row.id) && row.workspaceId === where.workspaceId),
      updateMany: async ({ where, data }: { where: { id: { in: string[] }; workspaceId: string }; data: Partial<Feedback> }) => {
        const rows = s.feedback.filter((row) => where.id.in.includes(row.id) && row.workspaceId === where.workspaceId)
        rows.forEach((row) => Object.assign(row, data))
        return { count: rows.length }
      },
    },
    opportunity: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `opp-${++seq}`, ...data }
        s.opportunities.push(row)
        return row
      },
    },
  })
  const db = {
    ...client(state),
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const draft = structuredClone(state)
      const result = await callback(client(draft))
      state = draft
      Object.assign(db, client(state))
      return result
    }),
    get state() {
      return state
    },
  }
  return db
}

const WS = "ws-1"
const seed = (): State => ({
  opportunities: [],
  feedback: [
    { id: "fb-1", workspaceId: WS, opportunityId: null, updatedAt: new Date(0), status: "OPEN" },
    { id: "fb-2", workspaceId: WS, opportunityId: "opp-old", updatedAt: new Date(0), status: "UNDER_REVIEW" },
    { id: "fb-foreign", workspaceId: "ws-2", opportunityId: null, updatedAt: new Date(0), status: "OPEN" },
  ],
  squads: [{ id: "sq-1", workspaceId: WS }, { id: "sq-foreign", workspaceId: "ws-2" }],
  keyResults: [{ id: "kr-1", workspaceId: WS }, { id: "kr-foreign", workspaceId: "ws-2" }],
})

let db: ReturnType<typeof makeDb>
const create = (input: Parameters<typeof createOpportunityWithLinks>[2]) =>
  createOpportunityWithLinks(db as unknown as AppPrismaClient, WS, input)

beforeEach(() => {
  db = makeDb(seed())
})

describe("normalizeNewOpportunityInput", () => {
  it("trims, defaults the status, empties blanks to null and de-duplicates feedback", () => {
    expect(
      normalizeNewOpportunityInput({
        title: "  Onboarding  ",
        description: "  ",
        customerSegment: " SMB ",
        feedbackIds: ["fb-1", "fb-1", "fb-2"],
      }),
    ).toEqual({
      ok: true,
      data: {
        title: "Onboarding",
        description: null,
        customerSegment: "SMB",
        status: "EXPLORING",
        squadId: null,
        linkedKeyResultId: null,
        feedbackIds: ["fb-1", "fb-2"],
      },
    })
  })

  it.each([
    [{ title: "   " }, /title/i],
    [{ title: "x".repeat(256) }, /255/],
    [{ title: "ok", customerSegment: "s".repeat(256) }, /segment/i],
    [{ title: "ok", status: "ARCHIVED" as never }, /status/i],
  ])("refuses %j", (input, message) => {
    const result = normalizeNewOpportunityInput(input)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(message)
  })
})

describe("createOpportunityWithLinks", () => {
  it("creates the opportunity with its key result and links the chosen feedback in one transaction", async () => {
    const opportunity = await create({
      title: "Onboarding stalls",
      status: "VALIDATING",
      squadId: "sq-1",
      linkedKeyResultId: "kr-1",
      feedbackIds: ["fb-1", "fb-2"],
    })
    expect(db.$transaction).toHaveBeenCalledOnce()
    expect(db.state.opportunities).toHaveLength(1)
    expect(db.state.opportunities[0]).toMatchObject({
      id: opportunity.id,
      workspaceId: WS,
      title: "Onboarding stalls",
      status: "VALIDATING",
      squadId: "sq-1",
      linkedKeyResultId: "kr-1",
    })
    const [fb1, fb2] = db.state.feedback
    expect(fb1.opportunityId).toBe(opportunity.id)
    // Re-linking moves an item off its old opportunity — same as the grid.
    expect(fb2.opportunityId).toBe(opportunity.id)
    // Same side effects as every other link path: updatedAt bumps, status stays.
    expect(fb1.updatedAt.getTime()).toBeGreaterThan(0)
    expect(fb1.status).toBe("OPEN")
    expect(fb2.status).toBe("UNDER_REVIEW")
  })

  it("is a plain create when nothing is linked", async () => {
    await create({ title: "Solo" })
    expect(db.state.opportunities[0]).toMatchObject({ linkedKeyResultId: null, squadId: null, status: "EXPLORING" })
    expect(db.state.feedback.every((row) => row.opportunityId !== "opp-1")).toBe(true)
  })

  it.each([
    ["a key result from another workspace", { linkedKeyResultId: "kr-foreign" }, /key result/i],
    ["an unknown key result", { linkedKeyResultId: "kr-missing" }, /key result/i],
    ["a squad from another workspace", { squadId: "sq-foreign" }, /squad/i],
    ["feedback from another workspace", { feedbackIds: ["fb-1", "fb-foreign"] }, /feedback/i],
    ["unknown feedback", { feedbackIds: ["fb-missing"] }, /feedback/i],
  ])("creates nothing and links nothing for %s", async (_label, extra, message) => {
    const before = structuredClone(db.state)
    await expect(create({ title: "Should not exist", ...extra })).rejects.toThrow(OpportunityCreateError)
    await expect(create({ title: "Should not exist", ...extra })).rejects.toThrow(message)
    expect(db.state).toEqual(before)
  })

  it("rolls back the opportunity when linking feedback fails part-way", async () => {
    const before = structuredClone(db.state)
    // One item moves to another workspace between the check and the write,
    // so the scoped update touches fewer rows than were asked for.
    const originalTransaction = db.$transaction.getMockImplementation()!
    db.$transaction.mockImplementationOnce(async (callback) =>
      originalTransaction(async (tx) => {
        const client = tx as { feedbackItem: { updateMany: (...a: unknown[]) => Promise<{ count: number }> } }
        client.feedbackItem.updateMany = async () => ({ count: 1 })
        return callback(tx)
      }),
    )
    await expect(create({ title: "Half", feedbackIds: ["fb-1", "fb-2"] })).rejects.toThrow(/feedback/i)
    expect(db.state).toEqual(before)
  })
})
