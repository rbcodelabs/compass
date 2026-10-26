import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { applyMigrations } from "@/lib/migrations/runner"
import { replayAllMigrations } from "./helpers/replay-migrations"

/**
 * 110 through the registered runner, on a throwaway schema of this suite's own, after every earlier migration has been
 * replayed. Proves the SQL runs, the postcondition passes, the receipt is earned, and a rerun is idempotent.
 *
 * Set ANTHROPIC_KEY_MIGRATION_DATABASE_URL to the local compass_e2e database to enable. The guard keeps it from ever pointing
 * anywhere else: this suite creates and drops schemas, which must never happen against DSQL or a shared database.
 */
const databaseUrl = process.env.ANTHROPIC_KEY_MIGRATION_DATABASE_URL
const MIGRATION = "110_workspace_anthropic_api_key"

describe.skipIf(!databaseUrl)("110 workspace anthropic api key through the registered runner", () => {
  const schema = `anthropic_key_mig_test_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const previous = process.env.DATABASE_URL
  let owned = false

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!["postgresql:", "postgres:"].includes(url.protocol) || !["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e" || url.searchParams.has("schema")) {
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

  it("replays every migration, adds both nullable columns, and earns the receipt", async () => {
    const result = await replayAllMigrations(pool, schema)
    const body = await result.json()
    expect(body.error).toBeUndefined()
    expect(result.status).toBe(200)

    const columns = await pool.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='workspaces' AND column_name IN ('anthropic_api_key_encrypted','anthropic_api_key_last4') ORDER BY column_name`,
      [schema],
    )
    expect(columns.rows).toEqual([
      { column_name: "anthropic_api_key_encrypted", data_type: "text", is_nullable: "YES" },
      { column_name: "anthropic_api_key_last4", data_type: "text", is_nullable: "YES" },
    ])
    const receipt = await pool.query(`SELECT finished_at FROM "${schema}"._prisma_migrations WHERE migration_name = $1`, [MIGRATION])
    expect(receipt.rows).toHaveLength(1)
    expect(receipt.rows[0].finished_at).not.toBeNull()
  }, 600_000)

  it("is idempotent: a second run of the same migration succeeds and adds no second receipt", async () => {
    const again = await applyMigrations(pool, schema, MIGRATION)
    expect(again.status).toBe(200)
    const receipts = await pool.query(`SELECT 1 FROM "${schema}"._prisma_migrations WHERE migration_name = $1`, [MIGRATION])
    expect(receipts.rows).toHaveLength(1)
  }, 120_000)
})
