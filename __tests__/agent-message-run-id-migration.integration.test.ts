import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { assertAgentMessageRunIdMigration } from "@/lib/migrations/agent-message-run-id"
import { applyMigrations } from "@/lib/migrations/runner"
import { replayAllMigrations } from "./helpers/replay-migrations"
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"

/**
 * 129 through the registered runner on a throwaway schema, after every earlier migration has been replayed.
 * Enable with INTEGRATION_TEST_DATABASE_URL (isolated local compass_e2e only). Aurora DSQL async-job behaviour is NOT
 * exercised here (plain Postgres strips ASYNC); that part is covered by the static and mocked-catalog tests.
 */
const databaseUrl = integrationDatabaseUrl
const MIGRATION = "129_agent_message_run_id"

describe.skipIf(!databaseUrl)("129 agent message run id through the registered runner", () => {
  const schema = `msg_run_id_test_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const previous = process.env.DATABASE_URL
  let owned = false
  const existingMessage = randomUUID()

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!["postgresql:", "postgres:"].includes(url.protocol) || !["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e" || url.searchParams.has("schema")) {
      throw new Error("Only isolated local compass_e2e is allowed")
    }
    process.env.DATABASE_URL = databaseUrl
    await pool.query(`CREATE SCHEMA "${schema}"`)
    owned = true
    const baseline = await replayAllMigrations(pool, schema, { before: MIGRATION })
    expect(baseline.status, await baseline.text()).toBe(200)
    await pool.query(`INSERT INTO "${schema}".agent_messages (id, conversation_id, role, content) VALUES ($1, $2, 'assistant', 'legacy message')`, [existingMessage, randomUUID()])
  }, 600_000)

  afterAll(async () => {
    if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await pool.end()
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  })

  it("upgrades prior migrations, preserves a legacy message and earns the receipt", async () => {
    const result = await applyMigrations(pool, schema, MIGRATION)
    const body = await result.json()
    expect(body.error).toBeUndefined()
    expect(result.status).toBe(200)
    const legacy = await pool.query(`SELECT run_id, content FROM "${schema}".agent_messages WHERE id = $1`, [existingMessage])
    expect(legacy.rows).toEqual([{ run_id: null, content: "legacy message" }])
    const client = await pool.connect()
    try {
      await assertAgentMessageRunIdMigration(client, schema)
    } finally {
      client.release()
    }
    const receipt = await pool.query(`SELECT finished_at FROM "${schema}"._prisma_migrations WHERE migration_name = $1`, [MIGRATION])
    expect(receipt.rows).toHaveLength(1)
    expect(receipt.rows[0].finished_at).not.toBeNull()
  }, 600_000)

  it("is idempotent: a second run succeeds and adds no second receipt", async () => {
    const again = await applyMigrations(pool, schema, MIGRATION)
    expect(again.status).toBe(200)
    const receipts = await pool.query(`SELECT 1 FROM "${schema}"._prisma_migrations WHERE migration_name = $1`, [MIGRATION])
    expect(receipts.rows).toHaveLength(1)
  })

  it("refuses a receipt when a same-named index has the wrong definition (IF NOT EXISTS must not hide drift)", async () => {
    await pool.query(`DROP INDEX "${schema}".idx_agent_messages_run`)
    await pool.query(`DELETE FROM "${schema}"._prisma_migrations WHERE migration_name = $1`, [MIGRATION])
    await pool.query(`CREATE INDEX idx_agent_messages_run ON "${schema}".agent_messages(conversation_id)`)
    const result = await applyMigrations(pool, schema, MIGRATION)
    expect(result.status).not.toBe(200)
    expect(await result.text()).toContain("idx_agent_messages_run has drifted")
    const receipt = await pool.query(`SELECT 1 FROM "${schema}"._prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL`, [MIGRATION])
    expect(receipt.rows).toHaveLength(0)

    await pool.query(`DROP INDEX "${schema}".idx_agent_messages_run`)
    const recovered = await applyMigrations(pool, schema, MIGRATION)
    expect(recovered.status, await recovered.text()).toBe(200)
    const finished = await pool.query(`SELECT 1 FROM "${schema}"._prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL`, [MIGRATION])
    expect(finished.rows).toHaveLength(1)
    const unfinished = await pool.query(`SELECT 1 FROM "${schema}"._prisma_migrations WHERE migration_name = $1 AND finished_at IS NULL`, [MIGRATION])
    expect(unfinished.rows).toHaveLength(1)
  }, 120_000)

  it("refuses a nullable generated UUID because the finalizer must write run_id", async () => {
    await pool.query(`ALTER TABLE "${schema}".agent_messages DROP COLUMN run_id`)
    await pool.query(`DELETE FROM "${schema}"._prisma_migrations WHERE migration_name = $1`, [MIGRATION])
    await pool.query(`ALTER TABLE "${schema}".agent_messages ADD COLUMN run_id UUID GENERATED ALWAYS AS (conversation_id) STORED`)
    await pool.query(`CREATE INDEX idx_agent_messages_run ON "${schema}".agent_messages(run_id)`)
    const result = await applyMigrations(pool, schema, MIGRATION)
    expect(result.status, await result.text()).not.toBe(200)
    const receipt = await pool.query(`SELECT 1 FROM "${schema}"._prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL`, [MIGRATION])
    expect(receipt.rows).toHaveLength(0)
  }, 120_000)
})
