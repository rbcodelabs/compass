import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

/**
 * Static guards for 074_portal_home_layout. The DDL that reaches Aurora DSQL is
 * the SQL file, not schema.prisma, so the two are pinned to each other here.
 */
const ROOT = process.cwd()
const NAME = "074_portal_home_layout"
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

  it("is one idempotent table then one async unique index", () => {
    expect(statements).toHaveLength(2)
    expect(statements[0]).toMatch(/^CREATE TABLE IF NOT EXISTS portal_home_layouts\s*\(/i)
    expect(statements[1]).toMatch(/^CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_portal_home_layouts_workspace ON portal_home_layouts\(workspace_id\)$/i)
  })

  it("uses no foreign keys, enums, triggers, alters or partial indexes", () => {
    expect(sql).not.toMatch(/REFERENCES|CREATE TYPE|CREATE TRIGGER|ALTER TABLE|\bWHERE\b|SERIAL/i)
  })

  it("carries the layout columns, with published_widgets nullable and draft_widgets not", () => {
    const table = statements[0]
    for (const column of ["workspace_id", "draft_widgets", "published_widgets", "published_at", "published_by_id", "created_at", "updated_at"]) {
      expect(table).toContain(column)
    }
    expect(table).toMatch(/draft_widgets\s+JSONB\s+NOT NULL/i)
    expect(table).toMatch(/published_widgets\s+JSONB\s*,/i)
  })

  it("maps the same table and unique index in schema.prisma", () => {
    expect(schema).toContain('@@map("portal_home_layouts")')
    expect(schema).toContain('map: "idx_portal_home_layouts_workspace"')
    expect(schema).not.toMatch(/model PortalHomeLayout \{[^}]*@relation/)
    expect(schema).not.toMatch(/model PortalHomeLayout \{[^}]*@updatedAt/)
  })

  it("waits for its async index and verifies before the receipt", () => {
    expect(runner).toMatch(/const ASYNC_WAIT_MIGRATIONS = \[[^\]]*"074_portal_home_layout"/)
    expect(runner).toMatch(/\["049_agent_identity"[^\]]*"074_portal_home_layout"[^\]]*\]\.includes\(migration\.name\)/)
    const assertion = runner.indexOf('migration.name === "074_portal_home_layout") await assertPortalHomeLayoutMigration')
    expect(assertion).toBeGreaterThan(-1)
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'))
  })
})
