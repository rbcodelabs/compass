import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { applyMigrations } from "@/lib/migrations/runner"
import { UNIFIED_CONVERSATIONS_MIGRATION } from "@/lib/migrations/unified-conversations"
import { replayAllMigrations } from "./helpers/replay-migrations"
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"

const databaseUrl = integrationDatabaseUrl

describe.skipIf(!databaseUrl)("125 unified conversations through the registered runner", () => {
  const schema = `unified_conv_mig_test_${randomUUID().replaceAll("-", "")}`
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

  it("replays every migration through 125_unified_conversations, adds all twelve nullable columns, and earns the receipt", async () => {
    const result = await replayAllMigrations(pool, schema)
    const body = await result.json()
    expect(body.error).toBeUndefined()
    expect(result.status).toBe(200)

    const columns = await pool.query(
      `SELECT table_name, column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = $1
          AND ((table_name = 'agent_conversations' AND column_name IN ('target_type', 'target_id', 'visibility', 'status', 'agent_mode', 'source', 'resolved_at', 'resolved_by_id'))
            OR (table_name = 'agent_messages' AND column_name IN ('author_name', 'author_type', 'message_kind', 'edited_at')))
        ORDER BY table_name, column_name`,
      [schema],
    )
    expect(columns.rows).toHaveLength(12)
    expect(columns.rows.every((r) => r.is_nullable === "YES")).toBe(true)

    const receipt = await pool.query(
      `SELECT finished_at FROM "${schema}"._prisma_migrations WHERE migration_name = $1`,
      [UNIFIED_CONVERSATIONS_MIGRATION],
    )
    expect(receipt.rows).toHaveLength(1)
    expect(receipt.rows[0].finished_at).not.toBeNull()
  }, 600_000)

  it("is idempotent: a second run of 125_unified_conversations succeeds and adds no second receipt", async () => {
    const again = await applyMigrations(pool, schema, UNIFIED_CONVERSATIONS_MIGRATION)
    expect(again.status).toBe(200)
    const receipts = await pool.query(
      `SELECT 1 FROM "${schema}"._prisma_migrations WHERE migration_name = $1`,
      [UNIFIED_CONVERSATIONS_MIGRATION],
    )
    expect(receipts.rows).toHaveLength(1)
  }, 120_000)
})
