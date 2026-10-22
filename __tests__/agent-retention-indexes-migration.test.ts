import { describe, expect, it, vi } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { assertAgentRetentionIndexesMigration } from "@/lib/migrations/agent-retention-indexes"

/** Static guards for 100_agent_retention_indexes: the SQL file is what reaches Aurora DSQL. */
const ROOT = process.cwd()
const NAME = "100_agent_retention_indexes"
const runner = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8")
const sqlPath = path.join(ROOT, "prisma/migrations", NAME, "migration.sql")
const sql = existsSync(sqlPath) ? readFileSync(sqlPath, "utf-8").split("\n").map((line) => line.replace(/--.*$/, "")).join("\n") : ""
const statements = sql.split(";").map((s) => s.trim()).filter(Boolean)

describe(NAME, () => {
  it("is registered exactly once, after 099", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${NAME}"`, "g"))]).toHaveLength(1)
    expect(existsSync(sqlPath)).toBe(true)
    expect(runner.indexOf(`name: "${NAME}"`)).toBeGreaterThan(runner.indexOf('name: "099_agent_owner_user_nullable"'))
  })

  it("is two idempotent async indexes and nothing else (DSQL: one DDL per transaction, no table change)", () => {
    expect(statements).toHaveLength(2)
    expect(statements[0]).toMatch(/^CREATE INDEX ASYNC IF NOT EXISTS idx_agent_run_events_created_at ON agent_run_events\(created_at\)$/i)
    expect(statements[1]).toMatch(/^CREATE INDEX ASYNC IF NOT EXISTS idx_agent_messages_created_at ON agent_messages\(created_at\)$/i)
    expect(sql).not.toMatch(/REFERENCES|CREATE TYPE|CREATE TRIGGER|ALTER TABLE|UNIQUE|\bWHERE\b|DROP/i)
  })

  it("is mirrored in schema.prisma with the same index names", () => {
    expect(schema).toContain('@@index([createdAt], map: "idx_agent_run_events_created_at")')
    expect(schema).toContain('@@index([createdAt], map: "idx_agent_messages_created_at")')
  })

  it("verifies before the receipt", () => {
    const assertion = runner.indexOf("migration.name === AGENT_RETENTION_INDEXES_MIGRATION) await assertAgentRetentionIndexesMigration")
    expect(assertion).toBeGreaterThan(-1)
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'))
  })

  it("postcondition fails closed while an index is missing or still building", async () => {
    const client = (rows: { name: string; valid: boolean }[]) => ({ query: vi.fn(async () => ({ rows })) }) as never
    await expect(assertAgentRetentionIndexesMigration(client([
      { name: "idx_agent_run_events_created_at", valid: true },
      { name: "idx_agent_messages_created_at", valid: true },
    ]), "compass")).resolves.toBeUndefined()
    await expect(assertAgentRetentionIndexesMigration(client([
      { name: "idx_agent_run_events_created_at", valid: true },
      { name: "idx_agent_messages_created_at", valid: false },
    ]), "compass")).rejects.toThrow(/idx_agent_messages_created_at/)
    await expect(assertAgentRetentionIndexesMigration(client([]), "compass")).rejects.toThrow(/missing or not ACTIVE/)
  })
})
