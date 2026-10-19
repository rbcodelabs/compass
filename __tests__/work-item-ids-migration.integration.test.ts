import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { assertWorkItemIdsMigration } from "@/lib/migrations/work-item-ids"
import { applyMigrations, partitionPendingMigrations } from "@/lib/migrations/runner"
import type { NextResponse } from "next/server"

/**
 * Replays every earlier migration one at a time. A single untargeted run cannot be used on a fresh
 * schema: 042 (the 039 repair) is an alternative of 039, so it is already settled in any real
 * environment, but a from-scratch run still attempts it after 040 has added source_fingerprint and
 * its fixed 061-column fingerprint refuses. Explicit-only migrations are left for their own tests.
 */
const SKIP_IN_REPLAY = new Set(["042_native_decision_gates_repair", "069_workspace_id_residual_backfill", "072_typed_links_residual_backfill"])
async function replayThrough092(pool: Pool, schema: string): Promise<NextResponse> {
  let last!: NextResponse
  for (const migration of partitionPendingMigrations(schema, new Set()).pending) {
    if (SKIP_IN_REPLAY.has(migration.name)) continue
    for (let attempt = 0; attempt < 100; attempt++) {
      last = await applyMigrations(pool, schema, migration.name)
      if (last.status !== 202) break
    }
    if (last.status !== 200) return last
  }
  return last
}

/**
 * 092 through the registered runner on a throwaway schema of this suite's own, after every earlier
 * migration (092 alters 14 tables created by them).
 *
 * Set WORK_ITEM_IDS_DATABASE_URL to the local compass_e2e database to enable. The guard below keeps
 * that var from ever pointing anywhere else: this suite creates and drops schemas.
 */
const databaseUrl = process.env.WORK_ITEM_IDS_DATABASE_URL
const MIGRATION = "092_work_item_ids"

describe.skipIf(!databaseUrl)("092 work item IDs migration through the registered runner", () => {
  const schema = `work_item_ids_test_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const previous = process.env.DATABASE_URL
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
    await pool.query(`CREATE SCHEMA "${schema}"`)
    owned = true
  }, 120_000)

  afterAll(async () => {
    if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await pool.end()
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  })

  it("applies, earns one receipt, enforces uniqueness per (workspace, prefix, number), and reruns as a no-op", async () => {
    const all = await replayThrough092(pool, schema)
    expect(all.status, JSON.stringify(await all.json())).toBe(200)

    const client = await pool.connect()
    try {
      await assertWorkItemIdsMigration(client, schema)
    } finally {
      client.release()
    }

    const workspaceId = randomUUID()
    const insertTask = (seqNumber: number | null, wsId = workspaceId, prefix: string | null = "TASK") =>
      pool.query(
        `INSERT INTO "${schema}".tasks(workspace_id,title,seq_prefix,seq_number) VALUES ($1,'t',$2,$3)`,
        [wsId, prefix, seqNumber],
      )
    await insertTask(1)
    await expect(insertTask(1)).rejects.toThrow(/duplicate key|unique/i)
    await insertTask(1, randomUUID())
    // Unnumbered rows never collide, so the table stays writable before the backfill.
    await insertTask(null, workspaceId, null)
    await insertTask(null, workspaceId, null)

    const repeated = await applyMigrations(pool, schema, MIGRATION)
    expect(repeated.status).toBe(200)
    const receipts = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "${schema}"._prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL`,
      [MIGRATION],
    )
    expect(receipts.rows[0].count).toBe(1)
  }, 300_000)

  it("fails its postcondition when a unique index is merely non-unique", async () => {
    const client = await pool.connect()
    try {
      await pool.query(`DROP INDEX "${schema}".idx_tasks_seq`)
      await pool.query(`CREATE INDEX idx_tasks_seq ON "${schema}".tasks (workspace_id, seq_prefix, seq_number)`)
      await expect(assertWorkItemIdsMigration(client, schema)).rejects.toThrow(/not ready or has drifted/)
    } finally {
      client.release()
    }
  })
})
