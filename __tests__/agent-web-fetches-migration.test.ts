import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"

/** Static guards for 124_agent_web_fetches: the SQL file is what reaches Aurora DSQL. */
const ROOT = process.cwd()
const NAME = "124_agent_web_fetches"
const runner = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8")
const manifest = readFileSync(path.join(ROOT, "lib/preview-automation/managed-manifest.ts"), "utf-8")
const sqlPath = path.join(ROOT, "prisma/migrations", NAME, "migration.sql")
const rawSql = existsSync(sqlPath) ? readFileSync(sqlPath, "utf-8") : ""
const sql = rawSql.split("\n").map(line => line.replace(/--.*$/, "")).join("\n")
const statements = sql.split(";").map(s => s.trim()).filter(Boolean)

describe(NAME, () => {
  it("is registered exactly once, after 123", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${NAME}"`, "g"))]).toHaveLength(1)
    expect(existsSync(sqlPath)).toBe(true)
    expect(runner.indexOf(`name: "${NAME}"`)).toBeGreaterThan(runner.indexOf('name: "123_agent_orchestrator_wakeups"'))
  })

  it("is one idempotent table and no index (the composite PK is the attempt ceiling)", () => {
    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/^CREATE TABLE IF NOT EXISTS agent_web_fetches\s*\(/i)
    expect(statements[0]).toMatch(/PRIMARY KEY \(credential_id, seq\)/i)
  })

  it("uses no foreign keys, enums, triggers, alters, unique or partial indexes, serials or JSONB", () => {
    expect(sql).not.toMatch(/REFERENCES|CREATE TYPE|CREATE TRIGGER|ALTER TABLE|UNIQUE|\bWHERE\b|SERIAL|CREATE INDEX|JSONB/i)
  })

  it("stores the URL, status and size, not page content or response headers", () => {
    const table = statements[0]
    expect(table).toMatch(/url\s+VARCHAR\(2048\)\s+NOT NULL/i)
    expect(table).toMatch(/http_status\s+INTEGER\s*,/i)
    expect(table).toMatch(/bytes\s+INTEGER\s+NOT NULL\s+DEFAULT 0/i)
    expect(table).not.toMatch(/snippet|content|body|title|header|cookie/i)
    expect(table).toMatch(/conversation_id\s+UUID\s*,/i)
  })

  it("maps the same table in schema.prisma with the same composite key", () => {
    expect(schema).toContain('@@map("agent_web_fetches")')
    const model = schema.slice(schema.indexOf("model AgentWebFetch {"))
    expect(model.slice(0, model.indexOf("\n}"))).toContain("@@id([credentialId, seq])")
    expect(model.slice(0, model.indexOf("\n}"))).not.toContain("@relation")
  })

  it("verifies before the receipt", () => {
    const assertion = runner.indexOf("migration.name === AGENT_WEB_FETCHES_MIGRATION) await assertAgentWebFetchesMigration")
    expect(assertion).toBeGreaterThan(-1)
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'))
  })

  it("is pinned in the reviewed manifest by the digest of the shipped SQL and its postcondition code", () => {
    const digest = (file: string) => createHash("sha256").update(readFileSync(path.join(ROOT, file))).digest("hex")
    expect(manifest).toContain(`"${NAME}": "${digest(`prisma/migrations/${NAME}/migration.sql`)}"`)
    expect(manifest).toContain(`"lib/migrations/agent-web-fetches.ts": "${digest("lib/migrations/agent-web-fetches.ts")}"`)
  })
})
