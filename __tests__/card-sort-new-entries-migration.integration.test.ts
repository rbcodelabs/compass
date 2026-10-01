import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { assertCardSortNewEntriesMigration } from "@/lib/migrations/card-sort-new-entries"
import { applyMigrations } from "@/lib/migrations/runner"

/**
 * 066 through the registered runner, on a throwaway schema of this suite's own.
 * Same guard and rationale as card-sort-rounds-migration.integration.test.ts:
 * `prisma db push` invents its own index names, so only the runner proves the SQL
 * and the postcondition assertion agree.
 */
const databaseUrl = process.env.CARD_SORT_DATABASE_URL

describe.skipIf(!databaseUrl)("066 card sort new entries migration through the registered runner", () => {
  const schema = `card_sort_ne_${randomUUID().replaceAll("-", "")}`
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
  })

  afterAll(async () => {
    if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await pool.end()
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  })

  it("creates the table and index, earns one receipt, and is idempotent", async () => {
    const result = await applyMigrations(pool, schema, "068_card_sort_new_entries")
    const body = await result.json()
    expect(body.error).toBeUndefined()
    expect(result.status).toBe(200)

    const client = await pool.connect()
    try {
      await assertCardSortNewEntriesMigration(client, schema)
    } finally {
      client.release()
    }

    // status defaults to PENDING so a row can never be born already resolved.
    const id = randomUUID()
    await pool.query(
      `INSERT INTO "${schema}".card_sort_new_entries(id,round_id,user_id,title) VALUES ($1,$2,$3,'Idea')`,
      [id, randomUUID(), randomUUID()]
    )
    const row = await pool.query<{ status: string; accepted_object_id: string | null }>(
      `SELECT status, accepted_object_id FROM "${schema}".card_sort_new_entries WHERE id = $1`,
      [id]
    )
    expect(row.rows[0]).toEqual({ status: "PENDING", accepted_object_id: null })

    const repeated = await applyMigrations(pool, schema, "068_card_sort_new_entries")
    expect(repeated.status).toBe(200)
    const receipts = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "${schema}"._prisma_migrations WHERE migration_name = '068_card_sort_new_entries' AND finished_at IS NOT NULL`
    )
    expect(receipts.rows[0].count).toBe(1)
  })

  it("fails its postcondition when the index is missing", async () => {
    const scratch = `${schema}_noindex`
    await pool.query(`CREATE SCHEMA "${scratch}"`)
    try {
      await applyMigrations(pool, scratch, "068_card_sort_new_entries")
      await pool.query(`DROP INDEX "${scratch}".idx_card_sort_new_entries_round_status`)
      const client = await pool.connect()
      try {
        await expect(assertCardSortNewEntriesMigration(client, scratch)).rejects.toThrow()
      } finally {
        client.release()
      }
    } finally {
      await pool.query(`DROP SCHEMA "${scratch}" CASCADE`)
    }
  })
})
