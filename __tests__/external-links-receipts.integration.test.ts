import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"
import { applyMigrations } from "@/lib/migrations/runner"

// Run only on an explicitly opted-in throwaway PostgreSQL database. It cannot prove DSQL's asynchronous job behavior.
describe.skipIf(!integrationDatabaseUrl)("external-link migration receipts", () => {
  const schema = "links_receipt_" + randomUUID().replaceAll("-", "")
  const pool = new Pool({ connectionString: integrationDatabaseUrl })
  const originalUrl = process.env.DATABASE_URL
  beforeAll(async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl
    await pool.query(`CREATE SCHEMA "${schema}"`)
  })
  afterAll(async () => {
    try {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    } finally {
      await pool.end()
      if (originalUrl === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = originalUrl
    }
  })
  it("applies on a fresh schema and preserves the finished receipt on replay", async () => {
    const apply = () => applyMigrations(pool, schema, "126_external_links")
    const receipts = () => pool.query(`SELECT id, finished_at FROM "${schema}"._prisma_migrations WHERE migration_name = '126_external_links'`)
    expect((await apply()).status).toBe(200)
    const first = (await receipts()).rows
    expect(first).toHaveLength(1)
    expect(first[0].finished_at).toBeInstanceOf(Date)
    expect((await apply()).status).toBe(200)
    expect((await receipts()).rows).toEqual(first)
  })
  it("leaves the receipt unfinished when the digest column is generated", async () => {
    const scratch = `${schema}_generated`
    await pool.query(`CREATE SCHEMA "${scratch}"`)
    try {
      const sql = readFileSync("prisma/migrations/126_external_links/migration.sql", "utf8")
      const start = sql.indexOf("CREATE TABLE IF NOT EXISTS external_links")
      const table = sql.slice(start, sql.indexOf(";", start))
        .replace("CREATE TABLE IF NOT EXISTS external_links", `CREATE TABLE "${scratch}".external_links`)
        .replace("external_key_hash VARCHAR(64) NOT NULL", "external_key_hash VARCHAR(64) GENERATED ALWAYS AS (repeat('a', 64)) STORED NOT NULL")
      await pool.query(table)
      const response = await applyMigrations(pool, scratch, "126_external_links")
      const { rows } = await pool.query(`SELECT finished_at FROM "${scratch}"._prisma_migrations WHERE migration_name = $1`, ["126_external_links"])
      expect(rows).toEqual([{ finished_at: null }])
      expect(response.status).toBe(500)
    } finally {
      await pool.query(`DROP SCHEMA "${scratch}" CASCADE`)
    }
  })
})
