import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { Pool } from "pg"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"
import { applyMigrations } from "@/lib/migrations/runner"
import { addExternalLink, findSubjectsByExternalKey } from "@/lib/external-links-service"
import { parseExternalLink } from "@/lib/external-links"

// Run only on an explicitly opted-in throwaway PostgreSQL database. It cannot prove DSQL's asynchronous job behavior.
describe.skipIf(!integrationDatabaseUrl)("external-link index byte budget", () => {
  const schema = `external_key_${randomUUID().replaceAll("-", "")}`
  const workspaceId = randomUUID()
  const taskId = randomUUID()
  const pool = new Pool({ connectionString: integrationDatabaseUrl, max: 6 })
  const originalUrl = process.env.DATABASE_URL
  let prisma: PrismaClient
  let created = false
  beforeAll(async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl
    await pool.query(`CREATE SCHEMA "${schema}"`)
    created = true
    const response = await applyMigrations(pool, schema, "126_external_links")
    expect(await response.json()).not.toHaveProperty("error")
    expect(response.status).toBe(200)
    // The service's subject authorization selects only these columns. Keep the diagnostic independent of unrelated schema.
    await pool.query(`CREATE TABLE "${schema}".tasks (id uuid PRIMARY KEY, workspace_id uuid NOT NULL)`)
    await pool.query(`INSERT INTO "${schema}".tasks VALUES ($1,$2)`, [taskId, workspaceId])
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) })
  })
  afterAll(async () => {
    await prisma?.$disconnect()
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await pool.end()
    if (originalUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = originalUrl
  })
  const inputs = [
    "https://example.com/" + "a".repeat(1000 - "https://example.com/".length),
    "https://example.com/" + "é".repeat(163) + "ab",
  ]
  it.each(inputs)("retains %s while every declared index key stays below 1 KiB", async (url) => {
    const parsed = parseExternalLink(url)!
    expect(parsed).not.toBeNull()
    expect(Buffer.byteLength(parsed.url, "utf8")).toBeLessThanOrEqual(1000)
    const result = await addExternalLink(prisma as never, { workspaceId, subjectType: "TASK", subjectId: taskId, url })
    expect(result.link.externalKey).toBe(parsed.externalKey)
    // Inspect the actual catalog keys, so the unchanged diagnostic measures raw keys before the repair and digest keys after it.
    const indexes = await pool.query<{name: string; columns: string[]}>(`SELECT c.relname AS name,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
        WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS columns
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname=ANY($2::text[])`, [schema, ["idx_external_links_subject_key", "idx_external_links_workspace_key"]])
    expect(indexes.rows).toHaveLength(2)
    for (const index of indexes.rows) {
      const terms = index.columns.map(column => {
        if (!["subject_type", "subject_id", "workspace_id", "provider", "external_key", "external_key_hash"].includes(column)) throw new Error("Unexpected index column")
        return column.endsWith("_id") ? "16" : `octet_length("${column}")`
      })
      const bytes = await pool.query(`SELECT ${terms.join(" + ")} AS key_bytes FROM "${schema}".external_links WHERE id=$1`, [result.link.id])
      expect(bytes.rows[0].key_bytes, index.name).toBeLessThan(1024)
    }
    const lookup = await findSubjectsByExternalKey(prisma as never, workspaceId, parsed.provider, parsed.externalKey)
    expect(lookup.map(row => row.id)).toContain(result.link.id)
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
  it("deduplicates concurrent creates without losing the full external key", async () => {
    const url = "https://example.com/" + "r".repeat(970)
    const results = await Promise.all(Array.from({ length: 2 }, () => addExternalLink(prisma as never, {workspaceId, subjectType: "TASK", subjectId: taskId, url})))
    expect(new Set(results.map(result => result.link.id)).size).toBe(1)
    expect(results.filter(result => result.created)).toHaveLength(1)
    expect(results[0].link.externalKey).toBe(url)
  })
})
