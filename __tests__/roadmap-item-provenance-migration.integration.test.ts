import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { applyMigrations } from "@/lib/migrations/runner"

// Runs 075 through the registered runner against a throwaway schema in the local
// compass_e2e database. Skipped unless UPDATES_TEST_DATABASE_URL is set (same
// convention as the 074 test).
const databaseUrl = process.env.UPDATES_TEST_DATABASE_URL
describe.skipIf(!databaseUrl)("roadmap item provenance registered migration", () => {
  const schema = `rip_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const previous = process.env.DATABASE_URL
  let created = false
  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") throw new Error("Requires local compass_e2e")
    process.env.DATABASE_URL = databaseUrl
    await pool.query(`CREATE SCHEMA "${schema}"`)
    created = true
    // A populated table: existing rows must come through untouched, with NULL in both new columns.
    await pool.query(`CREATE TABLE "${schema}".roadmap_items (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), title VARCHAR(255) NOT NULL)`)
    await pool.query(`INSERT INTO "${schema}".roadmap_items (title) VALUES ('legacy one'), ('legacy two')`)
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

  it("adds both nullable columns, leaves existing rows NULL, and reruns idempotently with one receipt", async () => {
    const first = await applyMigrations(pool, schema, "075_roadmap_item_provenance")
    const result = await first.json()
    expect(result, JSON.stringify(result)).not.toHaveProperty("error")
    expect(first.status).toBe(200)
    const columns = await pool.query("SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='roadmap_items' AND column_name IN ('auto_created','schedule_edited_at') ORDER BY column_name", [schema])
    expect(columns.rows).toEqual([
      { column_name: "auto_created", data_type: "boolean", is_nullable: "YES" },
      { column_name: "schedule_edited_at", data_type: "timestamp without time zone", is_nullable: "YES" },
    ])
    const rows = await pool.query(`SELECT auto_created, schedule_edited_at FROM "${schema}".roadmap_items`)
    expect(rows.rows).toEqual([{ auto_created: null, schedule_edited_at: null }, { auto_created: null, schedule_edited_at: null }])
    const again = await applyMigrations(pool, schema, "075_roadmap_item_provenance")
    expect(again.status).toBe(200)
    const receipts = await pool.query(`SELECT id FROM "${schema}"._prisma_migrations WHERE migration_name='075_roadmap_item_provenance' AND finished_at IS NOT NULL`)
    expect(receipts.rows).toHaveLength(1)
  })
})
