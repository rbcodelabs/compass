import { describe, expect, it } from "vitest"
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db"
import { allocateOneSeq, allocateSeq, withSeq, withSequenceTransaction } from "@/lib/work-item-sequence"

type Key = string
type FakeOptions = { failUpsertsWith?: unknown[] }

/**
 * In-memory stand-in for the counter table plus a transaction wrapper with PostgreSQL-like
 * semantics: a transaction that throws leaves no trace (counter and rows roll back together).
 */
function createFakeDb(options: FakeOptions = {}) {
  let counters = new Map<Key, number>()
  let rows: { workspaceId: string; type: string; seqPrefix: string; seqNumber: number }[] = []
  const failures = [...(options.failUpsertsWith ?? [])]
  let transactions = 0
  let upserts = 0

  const tx = {
    workspaceSequence: {
      async upsert(args: {
        where: { workspaceId_entityType: { workspaceId: string; entityType: string } }
        create: { workspaceId: string; entityType: string; nextValue: number }
        update: { nextValue: { increment: number } }
      }) {
        upserts++
        const failure = failures.shift()
        if (failure) throw failure
        const { workspaceId, entityType } = args.where.workspaceId_entityType
        const key = `${workspaceId}:${entityType}`
        const existing = counters.get(key)
        const nextValue = existing === undefined ? args.create.nextValue : existing + args.update.nextValue.increment
        counters.set(key, nextValue)
        return { workspaceId, entityType, nextValue }
      },
    },
    insert(workspaceId: string, type: string, seqPrefix: string, seqNumber: number) {
      rows.push({ workspaceId, type, seqPrefix, seqNumber })
    },
  }

  const prisma = {
    async $transaction<T>(callback: (client: unknown) => Promise<T>): Promise<T> {
      transactions++
      const snapshot = { counters: new Map(counters), rows: [...rows] }
      try {
        return await callback(tx)
      } catch (error) {
        counters = snapshot.counters
        rows = snapshot.rows
        throw error
      }
    },
  }

  return {
    tx: tx as unknown as AppTransactionClient,
    rawTx: tx,
    prisma: prisma as unknown as AppPrismaClient,
    counter: (workspaceId: string, type: string) => counters.get(`${workspaceId}:${type}`),
    rows: () => rows,
    stats: () => ({ transactions, upserts }),
  }
}

const WS = "11111111-1111-4111-8111-111111111111"
const OTHER_WS = "22222222-2222-4222-8222-222222222222"

describe("allocateSeq", () => {
  it("starts at 1 and counts up", async () => {
    const db = createFakeDb()
    expect(await allocateSeq(db.tx, WS, "task")).toEqual({ seqPrefix: "TASK", seqNumbers: [1] })
    expect(await allocateSeq(db.tx, WS, "task")).toEqual({ seqPrefix: "TASK", seqNumbers: [2] })
    expect(db.counter(WS, "task")).toBe(3)
  })

  it("keeps a separate counter per type and per workspace", async () => {
    const db = createFakeDb()
    await allocateSeq(db.tx, WS, "task")
    await allocateSeq(db.tx, WS, "task")
    expect((await allocateSeq(db.tx, WS, "opportunity")).seqNumbers).toEqual([1])
    expect((await allocateSeq(db.tx, OTHER_WS, "task")).seqNumbers).toEqual([1])
    expect((await allocateSeq(db.tx, WS, "task")).seqNumbers).toEqual([3])
  })

  it("reserves a consecutive range on a fresh counter", async () => {
    const db = createFakeDb()
    expect((await allocateSeq(db.tx, WS, "feedback", 3)).seqNumbers).toEqual([1, 2, 3])
    expect(db.counter(WS, "feedback")).toBe(4)
  })

  it("reserves a consecutive range after earlier allocations, with no overlap", async () => {
    const db = createFakeDb()
    await allocateSeq(db.tx, WS, "feedback", 2)
    expect((await allocateSeq(db.tx, WS, "feedback", 3)).seqNumbers).toEqual([3, 4, 5])
    expect((await allocateSeq(db.tx, WS, "feedback")).seqNumbers).toEqual([6])
  })

  it("rejects a bad count or workspace before touching the counter", async () => {
    const db = createFakeDb()
    for (const count of [0, -1, 1.5, Number.NaN]) {
      await expect(allocateSeq(db.tx, WS, "task", count)).rejects.toThrow(RangeError)
    }
    await expect(allocateSeq(db.tx, "", "task")).rejects.toThrow(/workspaceId/)
    expect(db.stats().upserts).toBe(0)
  })

  it("fails closed on a counter that cannot be right", async () => {
    const db = createFakeDb()
    const broken = { workspaceSequence: { upsert: async () => ({ nextValue: 1 }) } } as unknown as AppTransactionClient
    await expect(allocateSeq(broken, WS, "task", 3)).rejects.toThrow(/impossible counter/)
    expect(db.stats().upserts).toBe(0)
  })
})

describe("allocateOneSeq and withSeq", () => {
  it("returns create-payload columns", async () => {
    const db = createFakeDb()
    expect(await allocateOneSeq(db.tx, WS, "solution")).toEqual({ seqPrefix: "SOL", seqNumber: 1 })
  })

  it("assigns consecutive numbers to createMany rows and rejects a size mismatch", async () => {
    const db = createFakeDb()
    const range = await allocateSeq(db.tx, WS, "feedback", 2)
    expect(withSeq(range, [{ title: "a" }, { title: "b" }])).toEqual([
      { title: "a", seqPrefix: "FB", seqNumber: 1 },
      { title: "b", seqPrefix: "FB", seqNumber: 2 },
    ])
    expect(() => withSeq(range, [{ title: "a" }])).toThrow(RangeError)
  })
})

describe("withSequenceTransaction", () => {
  it("rolls the counter back with a failed create, leaving no gap", async () => {
    const db = createFakeDb()
    await expect(
      withSequenceTransaction(db.prisma, async (tx) => {
        await allocateSeq(tx, WS, "task")
        throw new Error("insert failed")
      }),
    ).rejects.toThrow("insert failed")
    expect(db.counter(WS, "task")).toBeUndefined()
    const created = await withSequenceTransaction(db.prisma, async (tx) => {
      const seq = await allocateOneSeq(tx, WS, "task")
      db.rawTx.insert(WS, "task", seq.seqPrefix, seq.seqNumber)
      return seq
    })
    expect(created.seqNumber).toBe(1)
    expect(db.rows()).toHaveLength(1)
  })

  it("replays the first-row race (P2002 on WorkspaceSequence) and then succeeds", async () => {
    const race = Object.assign(new Error("unique"), { code: "P2002", meta: { modelName: "WorkspaceSequence" } })
    const db = createFakeDb({ failUpsertsWith: [race] })
    const seq = await withSequenceTransaction(db.prisma, (tx) => allocateOneSeq(tx, WS, "task"))
    expect(seq.seqNumber).toBe(1)
    expect(db.stats().transactions).toBe(2)
  })

  it.each(["P2034", "40001", "OC000", "OC001"])("replays a commit conflict (%s)", async (code) => {
    const conflict = Object.assign(new Error("conflict"), { code })
    const db = createFakeDb({ failUpsertsWith: [conflict, conflict] })
    const seq = await withSequenceTransaction(db.prisma, (tx) => allocateOneSeq(tx, WS, "task"))
    expect(seq.seqNumber).toBe(1)
    expect(db.stats().transactions).toBe(3)
  })

  it("does not replay unrelated errors, nor a P2002 on another model", async () => {
    for (const error of [
      new Error("boom"),
      Object.assign(new Error("unique"), { code: "P2002", meta: { modelName: "Task" } }),
    ]) {
      const db = createFakeDb({ failUpsertsWith: [error] })
      await expect(withSequenceTransaction(db.prisma, (tx) => allocateOneSeq(tx, WS, "task"))).rejects.toBe(error)
      expect(db.stats().transactions).toBe(1)
    }
  })

  it("gives up after the retry budget", async () => {
    const conflict = Object.assign(new Error("conflict"), { code: "OC000" })
    const db = createFakeDb({ failUpsertsWith: [conflict, conflict, conflict, conflict, conflict] })
    await expect(withSequenceTransaction(db.prisma, (tx) => allocateOneSeq(tx, WS, "task"))).rejects.toBe(conflict)
    expect(db.stats().transactions).toBe(4)
  })

  it("hands 50 interleaved creators distinct dense numbers when the store serializes increments", async () => {
    const db = createFakeDb()
    const results = await Promise.all(
      Array.from({ length: 50 }, () => withSequenceTransaction(db.prisma, (tx) => allocateOneSeq(tx, WS, "task"))),
    )
    const numbers = results.map((r) => r.seqNumber).sort((a, b) => a - b)
    expect(numbers).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
  })
})
