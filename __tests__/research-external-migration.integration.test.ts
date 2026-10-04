import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { applyMigrations } from "@/lib/migrations/runner"

/**
 * Runs 076_research_external_studies through the registered runner (the code
 * behind /api/admin/migrate) on a schema owned by this test, against pre-076
 * research tables that already hold rows. Opt in with
 * RESEARCH_EXTERNAL_MIGRATION_DATABASE_URL pointing at the local compass_e2e
 * database; skipped by default so the normal suite stays hermetic.
 */
const databaseUrl = process.env.RESEARCH_EXTERNAL_MIGRATION_DATABASE_URL
const NAME = "076_research_external_studies"

describe.skipIf(!databaseUrl)("076 research external studies registered migration", () => {
  const schema = `research_external_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const previous = process.env.DATABASE_URL
  let created = false
  const studyId = randomUUID()
  const sessionId = randomUUID()

  const columns = async (table: string) =>
    (await pool.query(
      "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY column_name",
      [schema, table],
    )).rows

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e" || url.searchParams.has("schema")) {
      throw new Error("Requires local compass_e2e without schema override")
    }
    process.env.DATABASE_URL = databaseUrl
    await pool.query(`CREATE SCHEMA "${schema}"`)
    created = true
    await pool.query(`CREATE TABLE "${schema}".research_studies (id UUID PRIMARY KEY, name TEXT NOT NULL, study_type VARCHAR(30) NOT NULL, share_token_hash TEXT, share_expires_at TIMESTAMP)`)
    await pool.query(`CREATE TABLE "${schema}".research_sessions (id UUID PRIMARY KEY, study_id UUID NOT NULL, status VARCHAR(30) NOT NULL)`)
    await pool.query(`INSERT INTO "${schema}".research_studies (id, name, study_type) VALUES ($1, 'Legacy study', 'CUSTOMER_INTERVIEW')`, [studyId])
    await pool.query(`INSERT INTO "${schema}".research_sessions (id, study_id, status) VALUES ($1, $2, 'COMPLETED')`, [sessionId, studyId])
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

  it("adds the five nullable columns and leaves existing rows NULL (native behavior)", async () => {
    const response = await applyMigrations(pool, schema, NAME)
    const body = await response.json()
    expect(body, JSON.stringify(body)).not.toHaveProperty("error")
    expect(response.status).toBe(200)

    const studyColumns = await columns("research_studies")
    const sessionColumns = await columns("research_sessions")
    const added = [...studyColumns, ...sessionColumns].filter((c) => ["external_provider", "external_url", "provenance", "session_notes"].includes(c.column_name))
    expect(added).toHaveLength(5)
    expect(added.every((c) => c.is_nullable === "YES")).toBe(true)
    expect(studyColumns.map((c) => c.column_name)).toEqual(expect.arrayContaining(["external_provider", "external_url"]))
    expect(sessionColumns.map((c) => c.column_name)).toEqual(expect.arrayContaining(["external_url", "provenance", "session_notes"]))

    const study = (await pool.query(`SELECT external_provider, external_url FROM "${schema}".research_studies WHERE id=$1`, [studyId])).rows[0]
    const session = (await pool.query(`SELECT provenance, external_url, session_notes FROM "${schema}".research_sessions WHERE id=$1`, [sessionId])).rows[0]
    expect(study).toEqual({ external_provider: null, external_url: null })
    expect(session).toEqual({ provenance: null, external_url: null, session_notes: null })
  })

  it("is idempotent: a second run succeeds, changes nothing and keeps one completed receipt", async () => {
    const before = (await columns("research_sessions")).length
    const again = await applyMigrations(pool, schema, NAME)
    expect(again.status).toBe(200)
    expect((await columns("research_sessions")).length).toBe(before)
    const receipts = await pool.query(`SELECT id FROM "${schema}"._prisma_migrations WHERE migration_name=$1 AND finished_at IS NOT NULL`, [NAME])
    expect(receipts.rows).toHaveLength(1)
  })
})
