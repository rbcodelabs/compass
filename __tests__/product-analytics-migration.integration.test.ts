import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { applyMigrations } from "@/lib/migrations/runner"
import { assertProductAnalyticsMigration } from "@/lib/migrations/product-analytics"

const databaseUrl = process.env.ANALYTICS_MIGRATION_DATABASE_URL
describe.skipIf(!databaseUrl)("analytics migration through the registered runner", () => {
  const schema = `analytics_test_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const previous = process.env.DATABASE_URL
  let owned = false
  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (url.protocol !== "postgresql:" || !["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e" || url.searchParams.has("schema")) throw new Error("Only isolated local compass_e2e is allowed")
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
  it("applies, verifies all indexes, reruns without duplicate receipts, and enforces refresh uniqueness", async () => {
    const result = await applyMigrations(pool, schema, "061_product_analytics")
    const body = await result.json()
    expect(body.error).toBeUndefined()
    expect(result.status).toBe(200)
    const client = await pool.connect()
    try { await assertProductAnalyticsMigration(client, schema) } finally { client.release() }
    const repeated = await applyMigrations(pool, schema, "061_product_analytics")
    expect(repeated.status).toBe(200)
    const receipts = await pool.query(`SELECT COUNT(*)::int AS count FROM "${schema}"._prisma_migrations WHERE migration_name = '061_product_analytics' AND finished_at IS NOT NULL`)
    expect(receipts.rows[0].count).toBe(1)
    const insert = `INSERT INTO "${schema}".metric_observations(workspace_id,binding_id,revision_id,refresh_key,window_kind,snapshot_json,data_json) VALUES ($1,$2,$3,'refresh','BASELINE','{}','{}')`
    const ids = [randomUUID(), randomUUID(), randomUUID()]
    await pool.query(insert, ids)
    await expect(pool.query(insert, ids)).rejects.toThrow(/unique|duplicate/)
  })
})
