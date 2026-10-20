import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

/**
 * Static guards for 092_doc_changes. The DDL that reaches Aurora DSQL is the SQL file, not
 * schema.prisma, so the two are pinned to each other here.
 */
const ROOT = process.cwd()
const NAME = "092_doc_changes"
const runner = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8")
const sqlPath = path.join(ROOT, "prisma/migrations", NAME, "migration.sql")
const sql = existsSync(sqlPath)
  ? readFileSync(sqlPath, "utf-8").split("\n").map((line) => line.replace(/--.*$/, "")).join("\n")
  : ""
const statements = sql.split(";").map((s) => s.trim()).filter(Boolean)

describe(NAME, () => {
  it("is registered exactly once, after 091, with the async-wait and postcondition hooks", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${NAME}"`, "g"))]).toHaveLength(1)
    expect(runner.indexOf(`name: "${NAME}"`)).toBeGreaterThan(runner.indexOf('name: "091_entity_links"'))
    expect(runner).toContain(`migration.name === "${NAME}") await assertDocChangesMigration`)
    expect([...runner.matchAll(new RegExp(`"${NAME}"`, "g"))].length).toBeGreaterThanOrEqual(3)
  })

  it("is two idempotent tables then one async unique index", () => {
    expect(statements).toHaveLength(3)
    expect(statements[0]).toMatch(/^CREATE TABLE IF NOT EXISTS doc_changes\s*\(/i)
    expect(statements[1]).toMatch(/^CREATE TABLE IF NOT EXISTS doc_change_counters\s*\(\s*workspace_id UUID PRIMARY KEY,\s*last_seq INTEGER NOT NULL,\s*epoch VARCHAR\(36\) NOT NULL\s*\)$/i)
    expect(statements[2]).toMatch(/^CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_doc_changes_workspace_seq ON doc_changes\(workspace_id, seq\)$/i)
  })

  it("uses no foreign keys, sequences, enums, triggers, partial indexes, ASC/DESC or data statements", () => {
    expect(sql).not.toMatch(/REFERENCES|CREATE TYPE|CREATE TRIGGER|\bWHERE\b|SERIAL|SEQUENCE|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bASC\b|\bDESC\b|ALTER TABLE/i)
  })

  it("matches the Prisma model", () => {
    const model = schema.slice(schema.indexOf("model DocChange {"))
    const block = model.slice(0, model.indexOf("\n}"))
    for (const column of ["workspace_id", "doc_id", "seq", "kind", "revision", "path", "deleted_at", "created_at"]) {
      expect(statements[0]).toContain(column)
    }
    expect(block).toContain('@@map("doc_changes")')
    expect(block).toContain('@@unique([workspaceId, seq], map: "idx_doc_changes_workspace_seq")')
    expect(block).not.toContain("@relation")
    const counter = schema.slice(schema.indexOf("model DocChangeCounter {"))
    const counterBlock = counter.slice(0, counter.indexOf("\n}"))
    expect(counterBlock).toContain('workspaceId String @id @map("workspace_id") @db.Uuid')
    expect(counterBlock).toContain('@@map("doc_change_counters")')
  })
})
