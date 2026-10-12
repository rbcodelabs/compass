import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

/**
 * Static guards for 080_organization_slug_redirects. The DDL that reaches Aurora DSQL is the
 * SQL file, not schema.prisma, so the two are pinned to each other here.
 */
const ROOT = process.cwd()
const NAME = "080_organization_slug_redirects"
const runner = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8")
const sqlPath = path.join(ROOT, "prisma/migrations", NAME, "migration.sql")
const sql = existsSync(sqlPath)
  ? readFileSync(sqlPath, "utf-8").split("\n").map((line) => line.replace(/--.*$/, "")).join("\n")
  : ""
const statements = sql.split(";").map((s) => s.trim()).filter(Boolean)

describe(NAME, () => {
  it("is registered exactly once", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${NAME}"`, "g"))]).toHaveLength(1)
    expect(existsSync(sqlPath)).toBe(true)
  })

  it("is one idempotent table then one async UNIQUE index on old_slug", () => {
    expect(statements).toHaveLength(2)
    expect(statements[0]).toMatch(/^CREATE TABLE IF NOT EXISTS organization_slug_redirects\s*\(/i)
    expect(statements[1]).toMatch(
      /^CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_organization_slug_redirects_old_slug ON organization_slug_redirects\(old_slug\)$/i,
    )
  })

  it("uses no foreign keys, enums, triggers, alters or partial indexes", () => {
    expect(sql).not.toMatch(/REFERENCES|CREATE TYPE|CREATE TRIGGER|ALTER TABLE|\bWHERE\b|SERIAL/i)
  })

  it("has the columns the model maps, none of them nullable", () => {
    const table = statements[0]
    expect(table).toMatch(/organization_id\s+UUID\s+NOT NULL/i)
    expect(table).toMatch(/old_slug\s+VARCHAR\(255\)\s+NOT NULL/i)
    expect(table).toMatch(/created_at\s+TIMESTAMP\(3\)\s+NOT NULL/i)
  })

  it("maps the same table and unique index in schema.prisma, with no relation or @updatedAt", () => {
    const model = schema.match(/model OrganizationSlugRedirect \{[^}]*\}/)?.[0] ?? ""
    expect(model).toContain('@@map("organization_slug_redirects")')
    expect(model).toContain('map: "idx_organization_slug_redirects_old_slug"')
    expect(model).not.toMatch(/@relation|@updatedAt/)
  })

  it("waits for its async index and verifies before the receipt", () => {
    expect(runner).toMatch(/const ASYNC_WAIT_MIGRATIONS = \[[^\]]*"080_organization_slug_redirects"/)
    expect(runner).toMatch(/\["049_agent_identity"[^\]]*"080_organization_slug_redirects"[^\]]*\]\.includes\(migration\.name\)/)
    const assertion = runner.indexOf('migration.name === "080_organization_slug_redirects") await assertOrganizationSlugRedirectsMigration')
    expect(assertion).toBeGreaterThan(-1)
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'))
  })
})
