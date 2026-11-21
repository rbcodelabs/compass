import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { applyMigrations, partitionPendingMigrations } from "@/lib/migrations/runner"
import { assertReviewedManagedManifest } from "@/lib/preview-automation/managed-manifest"
import { integrationDatabaseUrl } from "./helpers/integration-database"
import { replayAllMigrations } from "./helpers/replay-migrations"

const migrations = [
  "126_doc_version_numbers",
  "127_decision_votes",
  "128_task_start_date",
  "129_agent_message_run_id",
  "130_agent_sandbox_operations",
] as const

describe.skipIf(!integrationDatabaseUrl)("schema-first migration batch on PostgreSQL", () => {
  const schema = "schema_first_" + randomUUID().replaceAll("-", "")
  const pool = new Pool({ connectionString: integrationDatabaseUrl, max: 2 })
  const previousDatabaseUrl = process.env.DATABASE_URL
  const legacyId = randomUUID()
  const workspaceId = randomUUID()
  let ownsSchema = false

  async function apply(name: string) {
    const response = await applyMigrations(pool, schema, name)
    expect(response.status, await response.text()).toBe(200)
  }

  function receipts(name: string) {
    return pool.query<{ finished: boolean }>(
      'SELECT finished_at IS NOT NULL AS finished FROM "' + schema + '"._prisma_migrations WHERE migration_name = $1 ORDER BY started_at',
      [name],
    )
  }

  async function expectBareNullableColumn(table: string, column: string, type: string) {
    const result = await pool.query(
      "SELECT data_type, is_nullable, column_default, is_generated FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3",
      [schema, table, column],
    )
    expect(result.rows).toEqual([{ data_type: type, is_nullable: "YES", column_default: null, is_generated: "NEVER" }])
  }

  beforeAll(async () => {
    // The pool owns the disposable target. The runner separately uses DATABASE_URL to
    // translate historical ASYNC DDL, including 001's users_email_key.
    process.env.DATABASE_URL = integrationDatabaseUrl
    await pool.query('CREATE SCHEMA "' + schema + '"')
    ownsSchema = true
    const baseline = await replayAllMigrations(pool, schema, { before: migrations[0] })
    expect(baseline.status, await baseline.text()).toBe(200)

    const emailIndex = await pool.query(
      "SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND tablename = 'users' AND indexname = 'users_email_key'",
      [schema],
    )
    expect(emailIndex.rowCount).toBe(1)
    await pool.query('INSERT INTO "' + schema + '".doc_versions (id, doc_id, title) VALUES ($1, $2, $3)', [legacyId, randomUUID(), "Legacy version"])
    await pool.query('INSERT INTO "' + schema + '".tasks (id, workspace_id, title, seq_prefix, seq_number) VALUES ($1, $2, $3, $4, $5)', [legacyId, workspaceId, "Legacy task", "TASK", 1])
    await pool.query('INSERT INTO "' + schema + '".agent_conversations (id, workspace_id, user_id, title) VALUES ($1, $2, $3, $4)', [legacyId, workspaceId, randomUUID(), "Legacy conversation"])
    await pool.query('INSERT INTO "' + schema + '".agent_messages (id, conversation_id, role, content) VALUES ($1, $1, $2, $3)', [legacyId, "assistant", "Legacy message"])
  }, 120_000)

  afterAll(async () => {
    try {
      if (ownsSchema) await pool.query('DROP SCHEMA "' + schema + '" CASCADE')
    } finally {
      try {
        await pool.end()
      } finally {
        if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL
        else process.env.DATABASE_URL = previousDatabaseUrl
      }
    }
  })

  it("applies the five exact migrations in order, preserves existing data, and replays finished receipts", async () => {
    const manifest = partitionPendingMigrations(schema, new Set()).pending
    const first = manifest.findIndex(({ name }) => name === migrations[0])
    expect(first).toBeGreaterThanOrEqual(0)
    expect(manifest.slice(first, first + migrations.length).map(({ name }) => name)).toEqual(migrations)
    assertReviewedManagedManifest(manifest)

    for (const name of migrations) {
      expect((await receipts(name)).rows).toEqual([])
      await apply(name)
      expect((await receipts(name)).rows).toEqual([{ finished: true }])
      await apply(name)
      expect((await receipts(name)).rows).toEqual([{ finished: true }])
    }

    await expectBareNullableColumn("doc_versions", "version_number", "integer")
    await expectBareNullableColumn("tasks", "start_date", "timestamp with time zone")
    await expectBareNullableColumn("agent_messages", "run_id", "uuid")
    await expectBareNullableColumn("agent_conversations", "sandbox_coordination_token", "uuid")
    const legacy = await pool.query(
      "SELECT d.title AS version_title, d.version_number, t.title AS task_title, t.start_date, m.content, m.run_id, c.title AS conversation_title, c.sandbox_coordination_token " +
      'FROM "' + schema + '".doc_versions d JOIN "' + schema + '".tasks t USING (id) ' +
      'JOIN "' + schema + '".agent_messages m USING (id) JOIN "' + schema + '".agent_conversations c USING (id) WHERE d.id = $1',
      [legacyId],
    )
    expect(legacy.rows).toEqual([{
      version_title: "Legacy version", version_number: null,
      task_title: "Legacy task", start_date: null,
      content: "Legacy message", run_id: null,
      conversation_title: "Legacy conversation", sandbox_coordination_token: null,
    }])
  }, 120_000)

  it.each([
    [migrations[1], "ALTER TABLE @schema@.decision_votes DROP CONSTRAINT decision_votes_pkey", "ALTER TABLE @schema@.decision_votes DROP CONSTRAINT IF EXISTS decision_votes_pkey", "ALTER TABLE @schema@.decision_votes ADD PRIMARY KEY (id)", "primary key"],
    [migrations[1], "ALTER TABLE @schema@.decision_votes ALTER COLUMN id DROP DEFAULT", "ALTER TABLE @schema@.decision_votes ALTER COLUMN id SET DEFAULT '00000000-0000-4000-8000-000000000001'::uuid", "ALTER TABLE @schema@.decision_votes ALTER COLUMN id SET DEFAULT gen_random_uuid()", "decision_votes.id"],
    [migrations[1], "ALTER TABLE @schema@.decision_votes ALTER COLUMN created_at TYPE TIMESTAMP(6)", "ALTER TABLE @schema@.decision_votes ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP", "ALTER TABLE @schema@.decision_votes ALTER COLUMN created_at TYPE TIMESTAMP(3)", "decision_votes.created_at"],
    [migrations[1], "ALTER TABLE @schema@.decision_votes ALTER COLUMN question_index DROP DEFAULT", "ALTER TABLE @schema@.decision_votes ALTER COLUMN question_index SET DEFAULT 0", "ALTER TABLE @schema@.decision_votes ALTER COLUMN question_index DROP DEFAULT", "decision_votes.question_index"],
    [migrations[1], "ALTER TABLE @schema@.decision_votes DROP COLUMN IF EXISTS extra_required", "ALTER TABLE @schema@.decision_votes ADD COLUMN extra_required TEXT NOT NULL", "ALTER TABLE @schema@.decision_votes DROP COLUMN extra_required", "unexpected columns"],
    [migrations[1], "ALTER TABLE @schema@.decision_votes ALTER COLUMN question_index DROP DEFAULT", "ALTER TABLE @schema@.decision_votes ALTER COLUMN question_index ADD GENERATED ALWAYS AS IDENTITY", "ALTER TABLE @schema@.decision_votes ALTER COLUMN question_index DROP IDENTITY", "decision_votes.question_index"],
    [migrations[1], "ALTER TABLE @schema@.decision_votes ALTER COLUMN id DROP DEFAULT", "ALTER TABLE @schema@.decision_votes ALTER COLUMN updated_at DROP DEFAULT", "ALTER TABLE @schema@.decision_votes ALTER COLUMN id SET DEFAULT gen_random_uuid(), ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP", "decision_votes.id"],
    [migrations[1], "ALTER TABLE @schema@.decision_votes ALTER COLUMN created_at DROP DEFAULT", "ALTER TABLE @schema@.decision_votes ALTER COLUMN updated_at DROP DEFAULT", "ALTER TABLE @schema@.decision_votes ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP, ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP", "decision_votes.created_at"],
    [migrations[1], "ALTER TABLE @schema@.decision_votes DROP CONSTRAINT decision_votes_pkey", "ALTER TABLE @schema@.decision_votes ADD PRIMARY KEY (request_id)", "ALTER TABLE @schema@.decision_votes DROP CONSTRAINT decision_votes_pkey, ADD PRIMARY KEY (id)", "primary key"],
    [migrations[0], "ALTER TABLE @schema@.doc_versions DROP COLUMN version_number", "ALTER TABLE @schema@.doc_versions ADD COLUMN version_number TEXT", "ALTER TABLE @schema@.doc_versions DROP COLUMN version_number", "doc_versions.version_number"],
    [migrations[1], "ALTER TABLE @schema@.decision_votes ALTER COLUMN chosen_option TYPE VARCHAR(1)", "ALTER TABLE @schema@.decision_votes ALTER COLUMN chosen_option TYPE VARCHAR(1)", "ALTER TABLE @schema@.decision_votes ALTER COLUMN chosen_option TYPE VARCHAR(120)", "decision_votes.chosen_option"],
    [migrations[2], "ALTER TABLE @schema@.tasks DROP COLUMN start_date", "ALTER TABLE @schema@.tasks ADD COLUMN start_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP", "ALTER TABLE @schema@.tasks DROP COLUMN start_date", "tasks.start_date"],
    [migrations[4], "ALTER TABLE @schema@.agent_sandbox_operations DROP COLUMN token", "ALTER TABLE @schema@.agent_sandbox_operations ADD COLUMN token UUID GENERATED ALWAYS AS (run_id) STORED NOT NULL", "ALTER TABLE @schema@.agent_sandbox_operations DROP COLUMN token, ADD COLUMN token UUID NOT NULL", "agent_sandbox_operations.token"],
    [migrations[4], "ALTER TABLE @schema@.agent_sandbox_operations DROP COLUMN IF EXISTS extra_required", "ALTER TABLE @schema@.agent_sandbox_operations ADD COLUMN extra_required TEXT NOT NULL", "ALTER TABLE @schema@.agent_sandbox_operations DROP COLUMN extra_required", "extra_required"],
    [migrations[1], "DROP INDEX IF EXISTS @schema@.idx_decision_votes_voter", "CREATE INDEX idx_decision_votes_voter ON @schema@.decision_votes(request_id)", "DROP INDEX @schema@.idx_decision_votes_voter", "idx_decision_votes_voter"],
    [migrations[4], "ALTER TABLE @schema@.agent_conversations DROP COLUMN IF EXISTS sandbox_coordination_token", "ALTER TABLE @schema@.agent_conversations ADD COLUMN sandbox_coordination_token UUID GENERATED ALWAYS AS (id) STORED", "ALTER TABLE @schema@.agent_conversations DROP COLUMN sandbox_coordination_token", "conversation coordination token"],
  ])("rejects drift for %s before receipt and retains the failed attempt on recovery", async (name, remove, drift, repair, error) => {
    // Install the schema independently so this regression also runs in isolation.
    await apply(name)
    await pool.query('DELETE FROM "' + schema + '"._prisma_migrations WHERE migration_name = $1', [name])
    for (const sql of [remove, drift]) await pool.query(sql.replace("@schema@", '"' + schema + '"'))
    const rejected = await applyMigrations(pool, schema, name)
    expect(rejected.status).toBe(500)
    expect(await rejected.text()).toContain(error)
    expect((await receipts(name)).rows).toEqual([{ finished: false }])

    await pool.query(repair.replace("@schema@", '"' + schema + '"'))
    await apply(name)
    expect((await receipts(name)).rows).toEqual([{ finished: false }, { finished: true }])
  })
})
