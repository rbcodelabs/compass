import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { assertBackgroundAgentRunsMigration } from "@/lib/migrations/background-agent-runs"
import { applyMigrations } from "@/lib/migrations/runner"

/**
 * 069 through the registered runner, on a throwaway schema of this suite's own.
 *
 * `prisma db push` is not a substitute: it invents its own index names, so it
 * would produce working tables while leaving the `idx_agent_run*` names the
 * postcondition assertion looks for absent. Running the migration and its
 * assertion together is the only way to know they agree.
 *
 * Set AGENT_RUNS_DATABASE_URL to the local compass_e2e database to enable. The
 * guard below keeps that var from ever pointing anywhere else -- this suite
 * creates and drops schemas, which must never happen against DSQL.
 */
const databaseUrl = process.env.AGENT_RUNS_DATABASE_URL
const MIGRATION = "069_background_agent_runs"

describe.skipIf(!databaseUrl)("069 background agent runs migration through the registered runner", () => {
  const schema = `agent_runs_test_${randomUUID().replaceAll("-", "")}`
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
    // DATABASE_URL being set is the runner's "local PostgreSQL" signal: it makes
    // the runner rewrite `INDEX ASYNC` to plain `INDEX` and skip the DSQL job-wait.
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

  it("creates both tables with the named indexes and earns exactly one receipt", async () => {
    const result = await applyMigrations(pool, schema, MIGRATION)
    const body = await result.json()
    expect(body.error).toBeUndefined()
    expect(result.status).toBe(200)

    // The runner already ran this postcondition before writing its receipt.
    // Asserting again proves the receipt was earned, not assumed.
    const client = await pool.connect()
    try {
      await assertBackgroundAgentRunsMigration(client, schema)
    } finally {
      client.release()
    }

    const runId = randomUUID()
    await pool.query(
      `INSERT INTO "${schema}".agent_runs(conversation_id,id,workspace_id,user_id,worker_token_hash,deadline_at) VALUES ($1,$2,$3,$4,$5,now())`,
      [randomUUID(), runId, randomUUID(), randomUUID(), "a".repeat(64)]
    )
    const defaults = await pool.query<{ status: string; kind: string; last_seq: number }>(
      `SELECT status, kind, last_seq FROM "${schema}".agent_runs WHERE id = $1`,
      [runId]
    )
    expect(defaults.rows[0]).toEqual({ status: "QUEUED", kind: "CHAT", last_seq: 0 })

    // The worker-token lookup must be unique: one token, one run.
    await expect(
      pool.query(
        `INSERT INTO "${schema}".agent_runs(conversation_id,workspace_id,user_id,worker_token_hash,deadline_at) VALUES ($1,$2,$3,$4,now())`,
        [randomUUID(), randomUUID(), randomUUID(), "a".repeat(64)]
      )
    ).rejects.toThrow(/duplicate key|unique/i)

    // (run_id, seq) is what makes a retried event batch idempotent.
    await pool.query(
      `INSERT INTO "${schema}".agent_run_events(run_id,seq,type,payload_json) VALUES ($1,1,'agent','{}')`,
      [runId]
    )
    await expect(
      pool.query(
        `INSERT INTO "${schema}".agent_run_events(run_id,seq,type,payload_json) VALUES ($1,1,'agent','{}')`,
        [runId]
      )
    ).rejects.toThrow(/duplicate key|unique/i)

    // IF NOT EXISTS makes the SQL a no-op on rerun; the receipt count proves the
    // runner agrees and does not record a second application.
    const repeated = await applyMigrations(pool, schema, MIGRATION)
    expect(repeated.status).toBe(200)
    const receipts = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "${schema}"._prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL`,
      [MIGRATION]
    )
    expect(receipts.rows[0].count).toBe(1)
  })

  it("fails its postcondition when the worker-token index is merely non-unique", async () => {
    // Guards the guard: a name-only check would pass here.
    const scratch = `${schema}_nonunique`
    await pool.query(`CREATE SCHEMA "${scratch}"`)
    try {
      await applyMigrations(pool, scratch, MIGRATION)
      await pool.query(`DROP INDEX "${scratch}".idx_agent_runs_worker_token`)
      await pool.query(`CREATE INDEX idx_agent_runs_worker_token ON "${scratch}".agent_runs (worker_token_hash)`)
      const client = await pool.connect()
      try {
        await expect(assertBackgroundAgentRunsMigration(client, scratch)).rejects.toThrow(/not unique/)
      } finally {
        client.release()
      }
    } finally {
      await pool.query(`DROP SCHEMA "${scratch}" CASCADE`)
    }
  })
})
