/** Apply the registered additive migration to a script-owned pre-feature schema. */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { applyMigrations } from "../lib/migrations/runner"
import { assertGeodeDocumentStorageMigration } from "../lib/migrations/geode-document-storage"

async function main() {
  const target = new URL(process.env.DATABASE_URL ?? "")
  assert(process.env.E2E_ISOLATED_DATABASE === "1" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) && target.pathname === "/compass_e2e", "Only disposable local compass_e2e is allowed")
  assert(!process.env.VERCEL_ENV && process.env.NODE_ENV !== "production")
  const schema = `compass_geode_${randomUUID().replaceAll("-", "")}_dev`
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const id = randomUUID()
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`)
    await pool.query(`CREATE TABLE "${schema}".docs (id UUID PRIMARY KEY, content TEXT)`)
    await pool.query(`CREATE TABLE "${schema}".doc_versions (id UUID PRIMARY KEY, content TEXT)`)
    await pool.query(`INSERT INTO "${schema}".docs (id,content) VALUES ($1,$2)`, [id, "\uFEFF existing legacy document\n"])
    await pool.query(`INSERT INTO "${schema}".doc_versions (id,content) VALUES ($1,$2)`, [id, "existing legacy version"])
    const before = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='docs'", [schema])
    assert.equal(before.rows.some(row => row.column_name === "storage_provider"), false)
    for (let pass = 0; pass < 2; pass++) {
      const response = await applyMigrations(pool, schema, "059_geode_document_storage")
      const result = await response.json()
      assert.equal(response.status, 200, JSON.stringify(result))
    }
    const client = await pool.connect()
    try { await assertGeodeDocumentStorageMigration(client, schema) } finally { client.release() }
    const current = await pool.query(`SELECT content,storage_provider,content_ref,revision FROM "${schema}".docs WHERE id=$1`, [id])
    assert.deepEqual(current.rows, [{ content: "\uFEFF existing legacy document\n", storage_provider: null, content_ref: null, revision: null }])
    const version = await pool.query(`SELECT content,storage_provider,content_ref FROM "${schema}".doc_versions WHERE id=$1`, [id])
    assert.deepEqual(version.rows, [{ content: "existing legacy version", storage_provider: null, content_ref: null }])
    const receipts = await pool.query(`SELECT count(*)::int AS count FROM "${schema}"._prisma_migrations WHERE migration_name=$1 AND finished_at IS NOT NULL`, ["059_geode_document_storage"])
    assert.equal(receipts.rows[0].count, 1)
    console.log("Registered migration added all059 columns/tables/index to pre-feature schema, preserved legacy content, and reran idempotently")
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await pool.end()
    console.log("Only the exact script-created schema was removed")
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
