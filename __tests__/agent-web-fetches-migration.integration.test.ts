import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { assertAgentWebFetchesMigration } from "@/lib/migrations/agent-web-fetches"
import { applyMigrations } from "@/lib/migrations/runner"
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"

/**
 * 124 through the registered runner, on a throwaway schema of this suite's own, so the SQL, the
 * postcondition and the receipt are proven to agree. Set INTEGRATION_TEST_DATABASE_URL to the local
 * compass_e2e database to enable (see __tests__/helpers/integration-database.ts).
 */
const MIGRATION = "124_agent_web_fetches"

describe.skipIf(!integrationDatabaseUrl)("124 agent web fetches migration through the registered runner", () => {
  const schema = `agent_web_fetches_test_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: integrationDatabaseUrl, max: 2 })
  const previous = process.env.DATABASE_URL
  let owned = false

  beforeAll(async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl
    await pool.query(`CREATE SCHEMA "${schema}"`)
    owned = true
  })

  afterAll(async () => {
    if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await pool.end()
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  })

  it("creates the table, earns exactly one receipt, and is idempotent on rerun", async () => {
    const result = await applyMigrations(pool, schema, MIGRATION)
    const body = await result.json()
    expect(body.error).toBeUndefined()
    expect(result.status).toBe(200)

    const client = await pool.connect()
    try {
      await assertAgentWebFetchesMigration(client, schema)
    } finally {
      client.release()
    }

    const credential = randomUUID()
    const insert = `INSERT INTO "${schema}".agent_web_fetches(credential_id,seq,user_id,workspace_id,url) VALUES ($1,$2,$3,$4,$5)`
    await pool.query(insert, [credential, 1, randomUUID(), randomUUID(), "https://example.com/"])
    const defaults = await pool.query<{ status: string; bytes: number; outcome: string | null; http_status: number | null }>(
      `SELECT status, bytes, outcome, http_status FROM "${schema}".agent_web_fetches WHERE credential_id = $1`,
      [credential],
    )
    expect(defaults.rows[0]).toEqual({ status: "STARTED", bytes: 0, outcome: null, http_status: null })
    // (credential_id, seq) is the attempt ceiling: a second claim of the same slot must lose.
    await expect(pool.query(insert, [credential, 1, randomUUID(), randomUUID(), "https://example.com/"])).rejects.toThrow(/duplicate key|unique/i)

    const repeated = await applyMigrations(pool, schema, MIGRATION)
    expect(repeated.status).toBe(200)
    const receipts = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "${schema}"._prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL`,
      [MIGRATION],
    )
    expect(receipts.rows[0].count).toBe(1)
  })

  it("fails its postcondition when the primary key is not (credential_id, seq)", async () => {
    // Guards the guard: a column-only check would pass here.
    const scratch = `${schema}_badkey`
    await pool.query(`CREATE SCHEMA "${scratch}"`)
    try {
      await applyMigrations(pool, scratch, MIGRATION)
      await pool.query(`ALTER TABLE "${scratch}".agent_web_fetches DROP CONSTRAINT agent_web_fetches_pkey`)
      await pool.query(`ALTER TABLE "${scratch}".agent_web_fetches ADD PRIMARY KEY (credential_id)`)
      const client = await pool.connect()
      try {
        await expect(assertAgentWebFetchesMigration(client, scratch)).rejects.toThrow(/keyed by \(credential_id, seq\)/)
      } finally {
        client.release()
      }
    } finally {
      await pool.query(`DROP SCHEMA "${scratch}" CASCADE`)
    }
  })

  it("fails its postcondition when a column is missing", async () => {
    const scratch = `${schema}_nocol`
    await pool.query(`CREATE SCHEMA "${scratch}"`)
    try {
      await applyMigrations(pool, scratch, MIGRATION)
      await pool.query(`ALTER TABLE "${scratch}".agent_web_fetches DROP COLUMN http_status`)
      const client = await pool.connect()
      try {
        await expect(assertAgentWebFetchesMigration(client, scratch)).rejects.toThrow(/http_status is missing/)
      } finally {
        client.release()
      }
    } finally {
      await pool.query(`DROP SCHEMA "${scratch}" CASCADE`)
    }
  })
})
