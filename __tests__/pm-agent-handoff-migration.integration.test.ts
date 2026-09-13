import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { applyMigrations } from "@/lib/migrations/runner"

const databaseUrl = process.env.PM_AGENT_HANDOFF_DATABASE_URL
describe.skipIf(!databaseUrl)("051 canonical migration on an owned local schema", () => {
  const schema = `pm_handoff_migration_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const previous = process.env.DATABASE_URL
  let created = false
  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (url.protocol !== "postgresql:" || !["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e" || url.searchParams.has("schema")) throw new Error("Requires local compass_e2e without schema override")
    process.env.DATABASE_URL = databaseUrl
    await pool.query(`CREATE SCHEMA "${schema}"`)
    created = true
    for (const table of ["pm_interviews", "agent_conversations", "api_keys"]) {
      await pool.query(`CREATE TABLE "${schema}"."${table}" (id UUID PRIMARY KEY)`)
    }
  })
  afterAll(async () => {
    try { if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`) }
    finally {
      await pool.end()
      if (previous === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previous
    }
  })

  it("adds four nullable columns and an exact valid unique index, then replays with one receipt", async () => {
    const migration = "051_pm_agent_handoff"
    const response = await applyMigrations(pool, schema, migration)
    const body = await response.json()
    expect(body, JSON.stringify(body)).not.toHaveProperty("error")
    expect(response.status).toBe(200)
    const columns = await pool.query("SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND column_name <> 'id' ORDER BY table_name, column_name", [schema])
    // Exclude the runner's own receipt table from the additive application DDL.
    expect(columns.rows.filter(row => row.table_name !== "_prisma_migrations")).toEqual([
      { table_name: "agent_conversations", column_name: "interview_processing_json", data_type: "text", is_nullable: "YES" },
      { table_name: "api_keys", column_name: "scope_claim_id", data_type: "uuid", is_nullable: "YES" },
      { table_name: "api_keys", column_name: "scope_conversation_id", data_type: "uuid", is_nullable: "YES" },
      { table_name: "pm_interviews", column_name: "agent_conversation_id", data_type: "uuid", is_nullable: "YES" },
    ])
    const index = await pool.query("SELECT i.indisunique, i.indisvalid, pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2", [schema, "idx_pm_interviews_agent_conversation"])
    expect(index.rows).toHaveLength(1)
    expect(index.rows[0]).toMatchObject({ indisunique: true, indisvalid: true })
    expect(index.rows[0].definition).toContain("ON " + schema + ".pm_interviews USING btree (agent_conversation_id)")
    expect((await applyMigrations(pool, schema, migration)).status).toBe(200)
    const receipts = await pool.query(`SELECT count(*)::int AS count FROM "${schema}"._prisma_migrations WHERE migration_name=$1 AND finished_at IS NOT NULL`, [migration])
    expect(receipts.rows[0].count).toBe(1)
  }, 30_000)
})
