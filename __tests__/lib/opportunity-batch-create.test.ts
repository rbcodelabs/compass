import { beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "@prisma/client"

vi.mock("@/lib/db", () => ({ default: vi.fn() }))
vi.mock("@/lib/work-item-sequence", async () => (await import("../helpers/work-item-sequence-mock")).workItemSequenceMock())
vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "user-1" } })) }))

import type { AppPrismaClient } from "@/lib/db"
import { PermissionError } from "@/lib/permissions"
import {
  BATCH_MAX_ITEMS,
  BatchRequestError,
  createOpportunityBatch,
  createSolutionBatch,
  normalizeNewSolutionInput,
  type BatchContext,
  type BatchItemResult,
} from "@/lib/opportunity-batch-create"

type Row = Record<string, unknown> & { id: string; workspaceId: string | null }
type State = { opportunities: Row[]; solutions: Row[]; squads: Row[]; keyResults: Row[] }

const matches = (row: Record<string, unknown>, where: Record<string, unknown> = {}) =>
  Object.entries(where).every(([key, value]) => (key === "objective" ? true : row[key] === value))

const p2002 = () => new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" })

/**
 * In-memory stand-in for the tables the batch core touches. A transaction works on a copy and commits it only when the
 * callback resolves, so "nothing was written" is asserted on state. The primary key is unique across workspaces, as in
 * the database, so a foreign id really collides.
 */
function makeDb(initial: State) {
  let state = structuredClone(initial)
  let transactions = 0
  const hideNextLookupOf = new Set<string>()
  const failTransactionNumbers = new Set<number>()
  const table = (s: State, key: "opportunities" | "solutions") => ({
    findFirst: async ({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: { sortOrder: "desc" } }) => {
      if (where && typeof where.id === "string" && hideNextLookupOf.delete(where.id)) return null
      const rows = s[key].filter((row) => matches(row, where))
      if (orderBy) rows.sort((a, b) => (b.sortOrder as number) - (a.sortOrder as number))
      return rows[0] ?? null
    },
    create: async ({ data }: { data: Row }) => {
      if (s[key].some((row) => row.id === data.id)) throw p2002()
      s[key].push({ ...data })
      return { ...data }
    },
  })
  const client = (s: State) => ({
    opportunity: table(s, "opportunities"),
    solution: table(s, "solutions"),
    squad: { findFirst: async ({ where }: { where: Record<string, unknown> }) => s.squads.find((row) => matches(row, where)) ?? null },
    keyResult: { findFirst: async () => null },
  })
  const db = {
    ...client(state),
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      transactions += 1
      const draft = structuredClone(state)
      const result = await callback(client(draft))
      if (failTransactionNumbers.has(transactions)) throw new Error("connection dropped before commit")
      state = draft
      Object.assign(db, client(state))
      return result
    }),
    get state() {
      return state
    },
    hideNextLookupOf,
    failTransactionNumbers,
  }
  return db
}

const WS = "11111111-1111-4111-8111-111111111111"
const OTHER = "22222222-2222-4222-8222-222222222222"
const PARENT = "33333333-3333-4333-8333-333333333333"
const FOREIGN_PARENT = "44444444-4444-4444-8444-444444444444"
const SQUAD = "55555555-5555-4555-8555-555555555555"
const FOREIGN_SQUAD = "66666666-6666-4666-8666-666666666666"
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

const seed = (): State => ({
  opportunities: [
    { id: PARENT, workspaceId: WS, title: "Parent", status: "EXPLORING", sortOrder: 0 },
    { id: FOREIGN_PARENT, workspaceId: OTHER, title: "Foreign parent", status: "EXPLORING", sortOrder: 0 },
  ],
  solutions: [],
  squads: [{ id: SQUAD, workspaceId: WS }, { id: FOREIGN_SQUAD, workspaceId: OTHER }],
  keyResults: [],
})

const ctx = (overrides: Partial<BatchContext> = {}): BatchContext => ({
  workspace: { id: WS, isReadOnly: false },
  caller: "human",
  source: "UI",
  mutationSource: { actorType: "USER", actorId: "user-1" },
  createdById: "user-1",
  ...overrides,
})

let db: ReturnType<typeof makeDb>
const prisma = () => db as unknown as AppPrismaClient
const opportunities = (n: number, from = 1) => Array.from({ length: n }, (_, i) => ({ clientId: uuid(from + i), title: `Opportunity ${from + i}` }))
const solutions = (n: number, from = 1, parent = PARENT) => Array.from({ length: n }, (_, i) => ({ clientId: uuid(1000 + from + i), parent: { id: parent }, title: `Solution ${from + i}` }))
const created = (results: BatchItemResult[]) => results.filter((r) => r.ok && !r.deduped).length
const ownRows = (rows: Row[]) => rows.filter((row) => row.id.startsWith("00000000"))

beforeEach(() => {
  db = makeDb(seed())
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("createOpportunityBatch", () => {
  it("creates 100 opportunities in input order with stable sortOrder and the workspace set", async () => {
    const { results } = await createOpportunityBatch(prisma(), ctx(), opportunities(100))
    expect(results).toHaveLength(100)
    expect(results.every((r) => r.ok)).toBe(true)
    expect(results.map((r) => r.clientId)).toEqual(opportunities(100).map((o) => o.clientId))
    const rows = ownRows(db.state.opportunities)
    expect(rows).toHaveLength(100)
    expect(rows.map((r) => r.sortOrder)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1)) // the seeded parent holds 0 in EXPLORING
    expect(rows.every((r) => r.workspaceId === WS && r.source === "UI")).toBe(true)
    expect(db.$transaction).toHaveBeenCalledTimes(100) // one transaction per item
  })

  it("is idempotent: resending the same payload creates exactly N", async () => {
    const payload = opportunities(5)
    await createOpportunityBatch(prisma(), ctx(), payload)
    const { results } = await createOpportunityBatch(prisma(), ctx(), payload)
    expect(results.every((r) => r.ok && r.deduped === true)).toBe(true)
    expect(ownRows(db.state.opportunities)).toHaveLength(5)
  })

  it("completes a batch whose first attempt was cut off mid-way, with no duplicates", async () => {
    const payload = opportunities(6)
    // The third item's commit is lost (connection dropped): items 1-2 landed, 3 did not, 4-6 were never sent in time.
    db.failTransactionNumbers.add(3)
    const first = await createOpportunityBatch(prisma(), ctx(), payload.slice(0, 3))
    expect(first.results.map((r) => r.ok)).toEqual([true, true, false])
    expect(first.results[2]).toMatchObject({ code: "INTERNAL" })
    const retry = await createOpportunityBatch(prisma(), ctx(), payload)
    expect(retry.results.every((r) => r.ok)).toBe(true)
    expect(retry.results.filter((r) => r.ok && r.deduped)).toHaveLength(2)
    expect(ownRows(db.state.opportunities)).toHaveLength(6)
  })

  it("reports per-item results and writes only the valid items (partial failure)", async () => {
    const { results } = await createOpportunityBatch(prisma(), ctx(), [
      { clientId: uuid(1), title: "Good" },
      { clientId: uuid(2), title: "   " },
      { clientId: uuid(3), title: "x".repeat(256) },
      { clientId: uuid(4), title: "Bad status", status: "ARCHIVED" },
      { clientId: uuid(5), title: "Wrong squad", squadId: FOREIGN_SQUAD },
      { clientId: uuid(6), title: "Fine", squadId: SQUAD },
      { clientId: "not-a-uuid", title: "Bad id" },
    ])
    expect(results.map((r) => (r.ok ? "ok" : r.code))).toEqual(["ok", "INVALID", "INVALID", "INVALID", "NOT_FOUND", "ok", "INVALID"])
    expect(results[4]).toMatchObject({ field: "squadId" })
    expect(ownRows(db.state.opportunities).map((r) => r.title)).toEqual(["Good", "Fine"])
  })

  it("refuses a repeated clientId inside one request", async () => {
    const { results } = await createOpportunityBatch(prisma(), ctx(), [
      { clientId: uuid(1), title: "A" },
      { clientId: uuid(1), title: "B" },
    ])
    expect(results.map((r) => r.ok)).toEqual([true, false])
    expect(ownRows(db.state.opportunities)).toHaveLength(1)
  })

  it("answers a generic CONFLICT for an id that belongs to another workspace and writes nothing", async () => {
    db.state.opportunities.push({ id: uuid(9), workspaceId: OTHER, title: "Secret", status: "EXPLORING", sortOrder: 0 })
    const before = db.state.opportunities.length
    const foreign = await createOpportunityBatch(prisma(), ctx(), [{ clientId: uuid(9), title: "Secret" }])
    // Same answer as for an id this workspace owns with different content, so the response does not say which it was.
    await createOpportunityBatch(prisma(), ctx(), [{ clientId: uuid(8), title: "Mine" }])
    const sameWorkspaceDifferent = await createOpportunityBatch(prisma(), ctx(), [{ clientId: uuid(8), title: "Changed" }])
    expect(foreign.results[0]).toEqual({ clientId: uuid(9), ok: false, code: "CONFLICT", error: "This id is already in use." })
    expect(sameWorkspaceDifferent.results[0]).toMatchObject({ ok: false, code: "CONFLICT", error: "This id is already in use." })
    expect(db.state.opportunities).toHaveLength(before + 1) // only "Mine"
    expect(db.state.opportunities.find((r) => r.id === uuid(9))).toMatchObject({ workspaceId: OTHER, title: "Secret" })
  })

  it("treats a lost primary-key race as a dedupe for the same workspace and content", async () => {
    await createOpportunityBatch(prisma(), ctx(), [{ clientId: uuid(1), title: "Same" }])
    db.hideNextLookupOf.add(uuid(1)) // the in-transaction existence check misses it, the insert then collides
    const { results } = await createOpportunityBatch(prisma(), ctx(), [{ clientId: uuid(1), title: "Same" }])
    expect(results[0]).toMatchObject({ ok: true, deduped: true })
    expect(ownRows(db.state.opportunities)).toHaveLength(1)
  })

  it("rejects a read-only workspace before any write", async () => {
    await expect(createOpportunityBatch(prisma(), ctx({ workspace: { id: WS, isReadOnly: true } }), opportunities(2))).rejects.toThrow(PermissionError)
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(ownRows(db.state.opportunities)).toHaveLength(0)
  })

  it("enforces the caps (100 human, 25 agent) with no writes, and accepts exactly the cap", async () => {
    expect(BATCH_MAX_ITEMS).toEqual({ human: 100, agent: 25 })
    await expect(createOpportunityBatch(prisma(), ctx(), opportunities(101))).rejects.toThrow(BatchRequestError)
    await expect(createOpportunityBatch(prisma(), ctx({ caller: "agent" }), opportunities(26))).rejects.toThrow(BatchRequestError)
    await expect(createOpportunityBatch(prisma(), ctx(), [])).rejects.toThrow(BatchRequestError)
    expect(db.$transaction).not.toHaveBeenCalled()
    const { results } = await createOpportunityBatch(prisma(), ctx({ caller: "agent", source: "MCP" }), opportunities(25))
    expect(created(results)).toBe(25)
  })
})

describe("createSolutionBatch", () => {
  it("creates solutions under the parent with the workspace taken from the authorized workspace", async () => {
    const { results } = await createSolutionBatch(prisma(), ctx(), solutions(3))
    expect(results.every((r) => r.ok)).toBe(true)
    const rows = ownRows(db.state.solutions)
    expect(rows.map((r) => r.sortOrder)).toEqual([0, 1, 2])
    expect(rows.every((r) => r.workspaceId === WS && r.opportunityId === PARENT)).toBe(true)
    expect(rows.every((r) => r.workspaceId !== null)).toBe(true)
  })

  it("answers NOT_FOUND, indistinguishably, for a foreign or missing parent and writes nothing", async () => {
    const { results } = await createSolutionBatch(prisma(), ctx(), [
      { clientId: uuid(1), parent: { id: FOREIGN_PARENT }, title: "Foreign" },
      { clientId: uuid(2), parent: { id: uuid(777) }, title: "Missing" },
      { clientId: uuid(3), parent: { id: PARENT }, title: "Fine" },
    ])
    expect(results[0]).toMatchObject({ ok: false, code: "NOT_FOUND" })
    expect(results[1]).toMatchObject({ ok: false, code: "NOT_FOUND" })
    expect((results[0] as { error: string }).error).toBe((results[1] as { error: string }).error)
    expect(results[2]).toMatchObject({ ok: true })
    expect(ownRows(db.state.solutions).map((r) => r.title)).toEqual(["Fine"])
  })

  it("is idempotent and does not let a retry move a solution to another parent", async () => {
    const payload = solutions(4)
    await createSolutionBatch(prisma(), ctx(), payload)
    const retry = await createSolutionBatch(prisma(), ctx(), payload)
    expect(retry.results.every((r) => r.ok && r.deduped)).toBe(true)
    expect(ownRows(db.state.solutions)).toHaveLength(4)
    db.state.opportunities.push({ id: uuid(500), workspaceId: WS, title: "Second parent", status: "EXPLORING", sortOrder: 1 })
    const moved = await createSolutionBatch(prisma(), ctx(), [{ ...payload[0], parent: { id: uuid(500) } }])
    expect(moved.results[0]).toMatchObject({ ok: false, code: "CONFLICT" })
  })

  it("refuses clientRef parents, a missing parent and a non-IDEA status per item", async () => {
    const { results } = await createSolutionBatch(prisma(), ctx(), [
      { clientId: uuid(1), parent: { clientRef: uuid(2) }, title: "Tree" },
      { clientId: uuid(2), title: "Orphan" },
      { clientId: uuid(3), parent: { id: PARENT }, title: "Shipped", status: "SHIPPED" },
    ])
    expect(results.map((r) => (r.ok ? "ok" : r.code))).toEqual(["INVALID", "INVALID", "INVALID"])
    expect(db.state.solutions).toHaveLength(0)
  })

  it("rejects a read-only workspace and an over-limit batch before any write", async () => {
    await expect(createSolutionBatch(prisma(), ctx({ workspace: { id: WS, isReadOnly: true } }), solutions(1))).rejects.toThrow(PermissionError)
    await expect(createSolutionBatch(prisma(), ctx(), solutions(101))).rejects.toThrow(BatchRequestError)
    await expect(createSolutionBatch(prisma(), ctx({ caller: "agent" }), solutions(26))).rejects.toThrow(BatchRequestError)
    expect(db.$transaction).not.toHaveBeenCalled()
  })
})

describe("normalizeNewSolutionInput", () => {
  it("trims, nulls a blank description and applies the shared caps", () => {
    expect(normalizeNewSolutionInput({ title: "  A  ", description: " ", parent: { id: PARENT } })).toEqual({
      ok: true,
      data: { title: "A", description: null, parentId: PARENT },
    })
    expect(normalizeNewSolutionInput({ title: " ", parent: { id: PARENT } })).toMatchObject({ ok: false, field: "title" })
    expect(normalizeNewSolutionInput({ title: "x".repeat(256), parent: { id: PARENT } })).toMatchObject({ ok: false, field: "title" })
    expect(normalizeNewSolutionInput({ title: "A", description: "d".repeat(10_001), parent: { id: PARENT } })).toMatchObject({ ok: false, field: "description" })
  })
})
