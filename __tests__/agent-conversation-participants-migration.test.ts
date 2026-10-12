import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

/**
 * Static guards for 082_agent_conversation_participants. The DDL that
 * reaches Aurora DSQL is the SQL file, not schema.prisma, so the two are pinned to each
 * other here.
 */
const ROOT = process.cwd()
const NAME = "082_agent_conversation_participants"
const runner = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8")
const sqlPath = path.join(ROOT, "prisma/migrations", NAME, "migration.sql")
const sql = existsSync(sqlPath)
  ? readFileSync(sqlPath, "utf-8").split("\n").map((line) => line.replace(/--.*$/, "")).join("\n")
  : ""
const statements = sql.split(";").map((s) => s.trim()).filter(Boolean)

describe(NAME, () => {
  it("is registered exactly once, directly after 079", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${NAME}"`, "g"))]).toHaveLength(1)
    expect(existsSync(sqlPath)).toBe(true)
    expect(runner.indexOf(`name: "${NAME}"`)).toBeGreaterThan(runner.indexOf('name: "079_agent_sessions"'))
  })

  it("is one idempotent table, two async indexes, then one bare nullable column", () => {
    expect(statements).toHaveLength(4)
    expect(statements[0]).toMatch(/^CREATE TABLE IF NOT EXISTS agent_conversation_participants\s*\(/i)
    expect(statements[1]).toMatch(
      /^CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_agent_conversation_participants_conversation_user ON agent_conversation_participants\(conversation_id, user_id\)$/i,
    )
    expect(statements[2]).toMatch(
      /^CREATE INDEX ASYNC IF NOT EXISTS idx_agent_conversation_participants_user_workspace ON agent_conversation_participants\(user_id, workspace_id\)$/i,
    )
    // DSQL rejects any constraint or DEFAULT on ADD COLUMN.
    expect(statements[3]).toMatch(/^ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS author_user_id UUID$/i)
  })

  it("uses no foreign keys, enums, triggers, partial indexes or backfill", () => {
    expect(sql).not.toMatch(/REFERENCES|CREATE TYPE|CREATE TRIGGER|\bWHERE\b|SERIAL|\bINSERT\b|\bUPDATE\b|\bDELETE\b/i)
  })

  it("carries the participant columns, with only removed_at nullable", () => {
    const table = statements[0]
    for (const column of ["conversation_id", "workspace_id", "user_id", "role", "added_by_user_id", "created_at", "updated_at", "removed_at"]) {
      expect(table).toContain(column)
    }
    expect(table).toMatch(/conversation_id\s+UUID\s+NOT NULL/i)
    expect(table).toMatch(/user_id\s+UUID\s+NOT NULL/i)
    expect(table).toMatch(/added_by_user_id\s+UUID\s+NOT NULL/i)
    expect(table).toMatch(/role\s+VARCHAR\(20\)\s+NOT NULL\s+DEFAULT\s+'PARTICIPANT'/i)
    expect(table).toMatch(/removed_at\s+TIMESTAMP\(3\)\s*$/im)
  })

  it("maps the same tables, indexes and column in schema.prisma", () => {
    expect(schema).toContain('@@map("agent_conversation_participants")')
    expect(schema).toContain('map: "idx_agent_conversation_participants_conversation_user"')
    expect(schema).toContain('map: "idx_agent_conversation_participants_user_workspace"')
    expect(schema).toMatch(/authorUserId\s+String\?\s+@map\("author_user_id"\) @db\.Uuid/)
    expect(schema).not.toMatch(/model AgentConversationParticipant \{[^}]*@updatedAt/)
  })

  it("waits for its async indexes and verifies before the receipt", () => {
    expect(runner).toMatch(/const ASYNC_WAIT_MIGRATIONS = \[[^\]]*"082_agent_conversation_participants"/)
    expect(runner).toMatch(/\["049_agent_identity"[^\]]*"082_agent_conversation_participants"[^\]]*\]\.includes\(migration\.name\)/)
    const assertion = runner.indexOf(
      'migration.name === "082_agent_conversation_participants") await assertAgentConversationParticipantsMigration',
    )
    expect(assertion).toBeGreaterThan(-1)
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'))
  })
})
