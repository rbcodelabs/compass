import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

/**
 * Static guards for 078_roadmap_views. The DDL that reaches Aurora DSQL is the SQL
 * file, not schema.prisma, so the two are pinned to each other here.
 */
const ROOT = process.cwd()
const NAME = "078_roadmap_views"
const runner = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8")
const sqlPath = path.join(ROOT, "prisma/migrations", NAME, "migration.sql")
const sql = existsSync(sqlPath)
  ? readFileSync(sqlPath, "utf-8").split("\n").map((line) => line.replace(/--.*$/, "")).join("\n")
  : ""
const statements = sql.split(";").map((s) => s.trim()).filter(Boolean)

describe(NAME, () => {
  it("is registered exactly once, directly after 076", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${NAME}"`, "g"))]).toHaveLength(1)
    expect(existsSync(sqlPath)).toBe(true)
    expect(runner.indexOf(`name: "${NAME}"`)).toBeGreaterThan(runner.indexOf('name: "076_research_external_studies"'))
  })

  it("is one idempotent table then one async non-unique index", () => {
    expect(statements).toHaveLength(2)
    expect(statements[0]).toMatch(/^CREATE TABLE IF NOT EXISTS roadmap_views\s*\(/i)
    expect(statements[1]).toMatch(/^CREATE INDEX ASYNC IF NOT EXISTS idx_roadmap_views_org_surface ON roadmap_views\(organization_id, workspace_id\)$/i)
  })

  it("uses no foreign keys, enums, triggers, alters, unique or partial indexes", () => {
    expect(sql).not.toMatch(/REFERENCES|CREATE TYPE|CREATE TRIGGER|ALTER TABLE|UNIQUE|\bWHERE\b|SERIAL/i)
  })

  it("carries the view columns, with workspace_id nullable and the rest not", () => {
    const table = statements[0]
    for (const column of ["organization_id", "workspace_id", "owner_id", "name", "visibility", "filters", "display", "created_at", "updated_at"]) {
      expect(table).toContain(column)
    }
    expect(table).toMatch(/organization_id\s+UUID\s+NOT NULL/i)
    expect(table).toMatch(/workspace_id\s+UUID\s*,/i)
    expect(table).toMatch(/owner_id\s+UUID\s+NOT NULL/i)
    expect(table).toMatch(/visibility\s+VARCHAR\(20\)\s+NOT NULL\s+DEFAULT\s+'PERSONAL'/i)
    expect(table).toMatch(/filters\s+JSONB\s+NOT NULL/i)
  })

  it("maps the same table and index in schema.prisma", () => {
    expect(schema).toContain('@@map("roadmap_views")')
    expect(schema).toContain('map: "idx_roadmap_views_org_surface"')
    expect(schema).not.toMatch(/model RoadmapView \{[^}]*@relation/)
    expect(schema).not.toMatch(/model RoadmapView \{[^}]*@updatedAt/)
  })

  it("waits for its async index and verifies before the receipt", () => {
    expect(runner).toMatch(/const ASYNC_WAIT_MIGRATIONS = \[[^\]]*"078_roadmap_views"/)
    expect(runner).toMatch(/\["049_agent_identity"[^\]]*"078_roadmap_views"[^\]]*\]\.includes\(migration\.name\)/)
    const assertion = runner.indexOf('migration.name === "078_roadmap_views") await assertRoadmapViewsMigration')
    expect(assertion).toBeGreaterThan(-1)
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'))
  })
})
