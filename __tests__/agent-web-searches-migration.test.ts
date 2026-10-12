import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

/** Static guards for 081_agent_web_searches: the SQL file is what reaches Aurora DSQL. */
const ROOT = process.cwd()
const NAME = "081_agent_web_searches"
const runner = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8")
const sqlPath = path.join(ROOT, "prisma/migrations", NAME, "migration.sql")
const sql = existsSync(sqlPath)
  ? readFileSync(sqlPath, "utf-8").split("\n").map(line => line.replace(/--.*$/, "")).join("\n")
  : ""
const statements = sql.split(";").map(s => s.trim()).filter(Boolean)

describe(NAME, () => {
  it("is registered exactly once, after 079", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${NAME}"`, "g"))]).toHaveLength(1)
    expect(existsSync(sqlPath)).toBe(true)
    expect(runner.indexOf(`name: "${NAME}"`)).toBeGreaterThan(runner.indexOf('name: "079_agent_sessions"'))
  })

  it("is one idempotent table and no index (the composite PK is the budget lookup)", () => {
    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/^CREATE TABLE IF NOT EXISTS agent_web_searches\s*\(/i)
    expect(statements[0]).toMatch(/PRIMARY KEY \(credential_id, seq\)/i)
  })

  it("uses no foreign keys, enums, triggers, alters, unique or partial indexes", () => {
    expect(sql).not.toMatch(/REFERENCES|CREATE TYPE|CREATE TRIGGER|ALTER TABLE|UNIQUE|\bWHERE\b|SERIAL|CREATE INDEX/i)
  })

  it("stores the query and result URLs, not page content", () => {
    const table = statements[0]
    expect(table).toMatch(/query\s+VARCHAR\(400\)\s+NOT NULL/i)
    expect(table).toMatch(/result_urls\s+JSONB\s+NOT NULL/i)
    expect(table).not.toMatch(/snippet|content|body|title/i)
    expect(table).toMatch(/conversation_id\s+UUID\s*,/i)
  })

  it("maps the same table in schema.prisma with the same composite key", () => {
    expect(schema).toContain('@@map("agent_web_searches")')
    expect(schema).toContain("@@id([credentialId, seq])")
    expect(schema).not.toMatch(/model AgentWebSearch \{[^}]*@relation/)
  })

  it("verifies before the receipt", () => {
    const assertion = runner.indexOf('migration.name === "081_agent_web_searches") await assertAgentWebSearchesMigration')
    expect(assertion).toBeGreaterThan(-1)
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'))
  })
})
