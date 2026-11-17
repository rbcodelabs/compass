import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { applyMigrations } from "@/lib/migrations/runner"
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"

// Runs 125 through the registered runner against a throwaway schema in the local compass_e2e database, over tables that already
// hold sessions and verification tokens. Skipped unless INTEGRATION_TEST_DATABASE_URL is set (same convention as 113/114).
const databaseUrl = integrationDatabaseUrl
describe.skipIf(!databaseUrl)("portal session workspace binding registered migration", () => {
  const schema = `psw_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const previous = process.env.DATABASE_URL
  let created = false
  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") throw new Error("Requires local compass_e2e")
    process.env.DATABASE_URL = databaseUrl
    await pool.query(`CREATE SCHEMA "${schema}"`)
    created = true
    await pool.query(`CREATE TABLE "${schema}".portal_sessions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), portal_account_id UUID NOT NULL, token_hash VARCHAR(64) NOT NULL UNIQUE, expires_at TIMESTAMP(3) NOT NULL)`)
    await pool.query(`INSERT INTO "${schema}".portal_sessions (portal_account_id, token_hash, expires_at) VALUES (gen_random_uuid(), 'a', now() + interval '1 day'), (gen_random_uuid(), 'b', now() + interval '1 day')`)
    await pool.query(`CREATE TABLE "${schema}".portal_verification_tokens (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email VARCHAR(255) NOT NULL, token_hash VARCHAR(64) NOT NULL UNIQUE, expires_at TIMESTAMP(3) NOT NULL)`)
    await pool.query(`INSERT INTO "${schema}".portal_verification_tokens (email, token_hash, expires_at) VALUES ('x@example.com', 'c', now() + interval '1 hour')`)
  })
  afterAll(async () => {
    try {
      if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    } finally {
      await pool.end()
      if (previous === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previous
    }
  })

  it("adds nullable workspace_id to both tables, keeps every existing row (NULL = never honored), and reruns idempotently with one receipt", async () => {
    const first = await applyMigrations(pool, schema, "125_portal_session_workspace")
    const result = await first.json()
    expect(result, JSON.stringify(result)).not.toHaveProperty("error")
    expect(first.status).toBe(200)
    for (const table of ["portal_sessions", "portal_verification_tokens"]) {
      const info = await pool.query("SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name='workspace_id'", [schema, table])
      expect(info.rows).toEqual([{ data_type: "uuid", is_nullable: "YES" }])
      const rows = await pool.query(`SELECT workspace_id FROM "${schema}".${table}`)
      expect(rows.rows.length).toBeGreaterThan(0)
      for (const row of rows.rows) expect(row.workspace_id).toBeNull()
    }
    const again = await applyMigrations(pool, schema, "125_portal_session_workspace")
    expect(again.status).toBe(200)
    const receipts = await pool.query(`SELECT id FROM "${schema}"._prisma_migrations WHERE migration_name=$1 AND finished_at IS NOT NULL`, ["125_portal_session_workspace"])
    expect(receipts.rows).toHaveLength(1)
  })
})
