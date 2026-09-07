import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { applyMigrations } from "@/lib/migrations/runner"

const databaseUrl = process.env.RESEARCH_VOICE_MIGRATION_DATABASE_URL
const run = databaseUrl ? describe : describe.skip

run("047 through the canonical migration runner on isolated PostgreSQL", () => {
  const schema = `voice_migration_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const previousDatabaseUrl = process.env.DATABASE_URL
  const voiceId = randomUUID()
  const chatId = randomUUID()
  const migration = "047_research_voice_control_plane"
  let ownedSchemaCreated = false

  beforeAll(async () => {
    const target = new URL(databaseUrl!)
    if (!["localhost", "127.0.0.1"].includes(target.hostname) || target.pathname !== "/compass_e2e") throw new Error("Voice migration integration requires local compass_e2e")
    process.env.DATABASE_URL = databaseUrl
    await pool.query(`CREATE SCHEMA "${schema}"`)
    ownedSchemaCreated = true
    await pool.query(`CREATE TABLE "${schema}".research_sessions (id UUID PRIMARY KEY, modality TEXT NOT NULL)`)
    await pool.query(`CREATE TABLE "${schema}".research_participant_tokens (id UUID PRIMARY KEY)`)
    await pool.query(`CREATE TABLE "${schema}".research_voice_events (id UUID PRIMARY KEY, provider_event_id VARCHAR(255))`)
    await pool.query(`CREATE TABLE "${schema}".research_turns (session_id UUID NOT NULL, content TEXT NOT NULL)`)
    await pool.query(`INSERT INTO "${schema}".research_sessions VALUES ($1,'VOICE'),($2,'CHAT')`, [voiceId, chatId])
    await pool.query(`INSERT INTO "${schema}".research_participant_tokens VALUES ($1)`, [randomUUID()])
    await pool.query(`INSERT INTO "${schema}".research_turns VALUES ($1,'hello'),($1,'world')`, [voiceId])
    await pool.query(`CREATE TABLE "${schema}"._prisma_migrations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), migration_name VARCHAR(255) NOT NULL, started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, finished_at TIMESTAMP)`)
    await pool.query(`INSERT INTO "${schema}"._prisma_migrations(migration_name) VALUES ($1)`, [migration])
    // Simulate the real interrupted deployment: matching call table and first
    // ACTIVE index exist, but counter backfills have not yet completed.
    const statements = readFileSync(new URL("../prisma/migrations/047_research_voice_control_plane/migration.sql", import.meta.url), "utf8").replace(/--[^\n]*/g, "").split(";").map((sql) => sql.trim()).filter(Boolean)
    const client = await pool.connect()
    try {
      await client.query(`SET search_path TO "${schema}"`)
      for (const statement of statements) {
        await client.query(statement.replace(/INDEX ASYNC/g, "INDEX"))
        if (statement.includes("idx_research_voice_calls_session_key")) break
      }
    } finally { client.release() }
  })

  afterAll(async () => {
    try {
      if (ownedSchemaCreated) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    } finally {
      try { await pool.end() } finally {
        if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL
        else process.env.DATABASE_URL = previousDatabaseUrl
      }
    }
  })

  it("resumes partial 047, backfills real data, verifies all indexes and replays without duplicate receipts", async () => {
    const response = await applyMigrations(pool, schema, migration, { preProvisionedSchema: true })
    const body = await response.json()
    expect(body, JSON.stringify(body)).not.toHaveProperty("error")
    expect(response.status).toBe(200)
    expect(body.researchVoiceControlPlane.indexes).toHaveLength(13)
    expect(body.researchVoiceControlPlane.indexesValid).toBe(true)
    expect((await pool.query(`SELECT voice_attempt_count, voice_turn_count, voice_transcript_chars FROM "${schema}".research_sessions WHERE id=$1`, [voiceId])).rows).toEqual([{ voice_attempt_count: 0, voice_turn_count: 2, voice_transcript_chars: 10 }])
    expect((await pool.query(`SELECT voice_count, voice_day_count FROM "${schema}".research_participant_tokens`)).rows).toEqual([{ voice_count: 0, voice_day_count: 0 }])
    expect((await applyMigrations(pool, schema, migration)).status).toBe(200)
    expect((await pool.query(`SELECT COUNT(*) FILTER (WHERE finished_at IS NULL)::int unfinished, COUNT(*) FILTER (WHERE finished_at IS NOT NULL)::int finished FROM "${schema}"._prisma_migrations WHERE migration_name=$1`, [migration])).rows).toEqual([{ unfinished: 1, finished: 1 }])
  })
})
