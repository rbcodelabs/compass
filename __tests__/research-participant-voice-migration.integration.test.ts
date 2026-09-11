import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { applyMigrations } from "@/lib/migrations/runner"
import { readFileSync } from "node:fs"
import { inspectVoiceMigrationCatalog, voiceMigrationCatalog } from "@/lib/research-voice-migration"

const databaseUrl = process.env.RESEARCH_PARTICIPANT_VOICE_DATABASE_URL
const run = databaseUrl ? describe : describe.skip
run("049 canonical migration on an owned local schema", () => {
  const schema = `participant_voice_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const previous = process.env.DATABASE_URL
  let created = false
  beforeAll(async () => {
    const target = new URL(databaseUrl!)
    if (!["localhost", "127.0.0.1"].includes(target.hostname) || target.pathname !== "/compass_e2e") throw new Error("Requires local compass_e2e")
    process.env.DATABASE_URL = databaseUrl
    await pool.query(`CREATE SCHEMA "${schema}"`)
    created = true
  })
  afterAll(async () => {
    try { if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`) }
    finally { await pool.end(); if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous }
  })
  it("applies with four valid exact indexes and replays without duplicate receipts", async () => {
    const migration = "049_research_participant_voice"
    const response = await applyMigrations(pool, schema, migration)
    const body = await response.json()
    expect(body, JSON.stringify(body)).not.toHaveProperty("error")
    expect(response.status).toBe(200)
    const client = await pool.connect()
    try {
      const catalog = voiceMigrationCatalog(readFileSync(new URL(`../prisma/migrations/049_research_participant_voice/migration.sql`, import.meta.url), "utf8"))
      const actual = await inspectVoiceMigrationCatalog(client, schema, catalog, true)
      expect(actual.indexes).toHaveLength(4)
      expect(actual.indexes.every((index) => index.valid)).toBe(true)
    } finally { client.release() }
    expect((await applyMigrations(pool, schema, migration)).status).toBe(200)
    const receipts = await pool.query(`SELECT count(*)::int count FROM "${schema}"._prisma_migrations WHERE migration_name=$1 AND finished_at IS NOT NULL`, [migration])
    expect(receipts.rows[0].count).toBe(1)
  })
})
