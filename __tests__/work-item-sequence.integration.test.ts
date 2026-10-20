import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { AppPrismaClient } from "@/lib/db"
import { resolveWorkItem } from "@/lib/work-item-resolve"
import { allocateOneSeq, allocateSeq, withSequenceTransaction } from "@/lib/work-item-sequence"
import { replayAllMigrations } from "./helpers/replay-migrations"

/**
 * Real-concurrency check of the allocator on PostgreSQL: N parallel creators in one workspace must
 * get exactly 1..N, a rolled-back create must leave no gap, and workspaces count independently.
 * (DSQL's OCC conflict path is covered by the unit tests' injected OC000/OC001/40001.)
 *
 * Set WORK_ITEM_IDS_DATABASE_URL to the local compass_e2e database to enable.
 */
const databaseUrl = process.env.WORK_ITEM_IDS_DATABASE_URL

describe.skipIf(!databaseUrl)("work item sequence allocator on real PostgreSQL", () => {
  const schema = `work_item_seq_test_${randomUUID().replaceAll("-", "")}`
  const admin = new Pool({ connectionString: databaseUrl, max: 2 })
  const appPool = new Pool({ connectionString: databaseUrl, max: 20 })
  const previous = process.env.DATABASE_URL
  let prisma: AppPrismaClient
  let owned = false

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (
      !["postgresql:", "postgres:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.pathname !== "/compass_e2e" ||
      url.searchParams.has("schema")
    ) {
      throw new Error("Only isolated local compass_e2e is allowed")
    }
    process.env.DATABASE_URL = databaseUrl
    await admin.query(`CREATE SCHEMA "${schema}"`)
    owned = true
    const result = await replayAllMigrations(admin, schema)
    expect(result.status, JSON.stringify(await result.json())).toBe(200)
    prisma = new PrismaClient({ adapter: new PrismaPg(appPool, { schema }) }) as unknown as AppPrismaClient
  }, 180_000)

  afterAll(async () => {
    await (prisma as unknown as PrismaClient | undefined)?.$disconnect()
    if (owned) await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  })

  const createTask = (workspaceId: string, failAfter = false) =>
    withSequenceTransaction(prisma, async (tx) => {
      const seq = await allocateOneSeq(tx, workspaceId, "task")
      const row = await tx.task.create({ data: { workspaceId, title: "t", ...seq } })
      if (failAfter) throw new Error("boom")
      return row
    })

  const numbers = async (workspaceId: string) =>
    (await admin.query(`SELECT seq_number FROM "${schema}".tasks WHERE workspace_id=$1 ORDER BY seq_number`, [workspaceId])).rows.map((r) => r.seq_number)

  it("gives 50 parallel creators exactly 1..50 on a brand-new workspace (first-row race)", async () => {
    const workspaceId = randomUUID()
    const rows = await Promise.all(Array.from({ length: 50 }, () => createTask(workspaceId)))
    expect(rows).toHaveLength(50)
    expect(await numbers(workspaceId)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
  }, 60_000)

  it("keeps counting densely across a second parallel wave", async () => {
    const workspaceId = randomUUID()
    await Promise.all(Array.from({ length: 20 }, () => createTask(workspaceId)))
    await Promise.all(Array.from({ length: 20 }, () => createTask(workspaceId)))
    expect(await numbers(workspaceId)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1))
  }, 60_000)

  it("leaves no gap when a create rolls back", async () => {
    const workspaceId = randomUUID()
    await createTask(workspaceId)
    await expect(createTask(workspaceId, true)).rejects.toThrow("boom")
    await createTask(workspaceId)
    expect(await numbers(workspaceId)).toEqual([1, 2])
  })

  it("counts workspaces and types independently, and hands out ranges", async () => {
    const a = randomUUID()
    const b = randomUUID()
    await Promise.all([createTask(a), createTask(b), createTask(a), createTask(b)])
    expect(await numbers(a)).toEqual([1, 2])
    expect(await numbers(b)).toEqual([1, 2])
    const range = await withSequenceTransaction(prisma, (tx) => allocateSeq(tx, a, "task", 3))
    expect(range.seqNumbers).toEqual([3, 4, 5])
    const other = await withSequenceTransaction(prisma, (tx) => allocateOneSeq(tx, a, "opportunity"))
    expect(other.seqNumber).toBe(1)
  })

  it("resolves display IDs and UUIDs inside their own workspace only", async () => {
    const a = randomUUID()
    const b = randomUUID()
    const taskA = await createTask(a)
    await createTask(b)
    const db = prisma as unknown as object
    expect(await resolveWorkItem(db, a, "task", "task-1")).toMatchObject({ ok: true, id: taskA.id, displayId: "TASK-1" })
    expect(await resolveWorkItem(db, a, "task", taskA.id)).toMatchObject({ ok: true, canonical: "TASK-1" })
    // The same number in another workspace is a different row; a foreign UUID is not found.
    const inB = await resolveWorkItem(db, b, "task", "TASK-1")
    expect(inB).toMatchObject({ ok: true })
    expect(inB.ok && inB.id).not.toBe(taskA.id)
    expect(await resolveWorkItem(db, b, "task", taskA.id)).toMatchObject({ ok: false, reason: "not_found" })
    expect(await resolveWorkItem(db, a, "task", "TASK-2")).toMatchObject({ ok: false, reason: "not_found" })
    expect(await resolveWorkItem(db, a, "opportunity", "TASK-1")).toEqual({ ok: false, reason: "wrong_type", message: "TASK-1 is a Task" })
  })
})
