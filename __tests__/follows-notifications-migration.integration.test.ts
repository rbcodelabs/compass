import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { applyMigrations } from "@/lib/migrations/runner"

// Runs 068 through the registered runner against a throwaway schema in the
// local compass_e2e database, then exercises the real Prisma models against the
// resulting tables. Skipped unless UPDATES_TEST_DATABASE_URL is set (same
// convention as the 060 workspace-updates integration test).
const databaseUrl = process.env.UPDATES_TEST_DATABASE_URL
describe.skipIf(!databaseUrl)("follows and notifications registered migration", () => {
  const schema = `follows_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const previous = process.env.DATABASE_URL
  let created = false
  let prisma: PrismaClient
  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") throw new Error("Requires local compass_e2e")
    process.env.DATABASE_URL = databaseUrl
    await pool.query(`CREATE SCHEMA "${schema}"`)
    created = true
  })
  afterAll(async () => {
    try {
      await prisma?.$disconnect()
      if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    } finally {
      await pool.end()
      if (previous === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previous
    }
  })

  it("creates both tables and all five indexes, and reruns with one completed receipt", async () => {
    const first = await applyMigrations(pool, schema, "068_follows_notifications")
    const result = await first.json()
    expect(result, JSON.stringify(result)).not.toHaveProperty("error")
    expect(first.status).toBe(200)
    const tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name IN ('follows','notifications') ORDER BY table_name", [schema])
    expect(tables.rows.map((r) => r.table_name)).toEqual(["follows", "notifications"])
    const indexes = await pool.query(
      "SELECT c.relname,i.indisunique,i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND (c.relname LIKE 'idx\\_follows\\_%' OR c.relname LIKE 'idx\\_notifications\\_%') ORDER BY c.relname",
      [schema],
    )
    const mine = indexes.rows
    expect(mine.map((r) => r.relname)).toEqual(["idx_follows_subject", "idx_follows_user_subject", "idx_follows_workspace_user", "idx_notifications_inbox", "idx_notifications_recipient_dedupe"])
    expect(mine.every((r) => r.indisvalid)).toBe(true)
    const again = await applyMigrations(pool, schema, "068_follows_notifications")
    expect(again.status).toBe(200)
    const receipts = await pool.query(`SELECT id FROM "${schema}"._prisma_migrations WHERE migration_name='068_follows_notifications' AND finished_at IS NOT NULL`)
    expect(receipts.rows).toHaveLength(1)
  })

  it("lets the Prisma models enforce follow uniqueness and skip duplicate notifications", async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) })
    const [workspaceId, userId, subjectId] = [randomUUID(), randomUUID(), randomUUID()]
    const follow = { workspaceId, userId, subjectType: "TASK", subjectId, state: "FOLLOWING", source: "MANUAL" }
    await prisma.follow.create({ data: follow })
    await expect(prisma.follow.create({ data: follow })).rejects.toMatchObject({ code: "P2002" })
    const inserted = await prisma.follow.createMany({ data: [follow], skipDuplicates: true })
    expect(inserted.count).toBe(0)

    const notification = { workspaceId, recipientUserId: userId, subjectType: "TASK", subjectId, kind: "STATUS_CHANGED", actorType: "USER", actorId: randomUUID(), payload: { from: "TODO", to: "DONE" }, dedupeKey: "status:x:1" }
    const first = await prisma.notification.createMany({ data: [notification], skipDuplicates: true })
    const replay = await prisma.notification.createMany({ data: [notification], skipDuplicates: true })
    expect([first.count, replay.count]).toEqual([1, 0])
    const rows = await prisma.notification.findMany({ where: { recipientUserId: userId } })
    expect(rows).toHaveLength(1)
    expect(rows[0].readAt).toBeNull()
    expect(rows[0].payload).toEqual({ from: "TODO", to: "DONE" })
  })
})
