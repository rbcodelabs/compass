import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { assertCustomFieldInheritanceRulesMigration } from "@/lib/migrations/custom-field-inheritance-rules"

/**
 * Static guards for 113_custom_field_inheritance_rules. The DDL that reaches Aurora DSQL is the SQL file,
 * not schema.prisma, so the two are pinned to each other here, and the file is checked against the DSQL
 * rules (no FKs, no unsupported DDL, one statement per step, ASYNC indexes).
 */
const ROOT = process.cwd()
const NAME = "113_custom_field_inheritance_rules"
const runner = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8")
const sqlPath = path.join(ROOT, "prisma/migrations", NAME, "migration.sql")
const rawSql = existsSync(sqlPath) ? readFileSync(sqlPath, "utf-8") : ""
const sql = rawSql.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n")
const statements = sql.split(";").map((s) => s.trim()).filter(Boolean)

describe(NAME, () => {
  it("is registered exactly once, in the runner's MIGRATIONS, with its SQL file", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${NAME}"`, "g"))]).toHaveLength(1)
    expect(existsSync(sqlPath)).toBe(true)
  })

  it("is one idempotent table then three async indexes, each its own statement", () => {
    expect(statements).toHaveLength(4)
    expect(statements[0]).toMatch(/^CREATE TABLE IF NOT EXISTS "?custom_field_inheritance_rules"?\s*\(/i)
    for (const statement of statements.slice(1)) {
      expect(statement).toMatch(/^CREATE (UNIQUE )?INDEX ASYNC IF NOT EXISTS /i)
    }
    expect(statements.filter((s) => /^CREATE UNIQUE INDEX/i.test(s))).toHaveLength(2)
  })

  it("generates only DSQL-supported DDL: no foreign keys, enums, triggers, alters, partial or DESC indexes, serials", () => {
    expect(sql).not.toMatch(/REFERENCES|FOREIGN KEY|CREATE TYPE|CREATE TRIGGER|ALTER TABLE|\bWHERE\b|\bDESC\b|SERIAL|CONCURRENTLY|DROP /i)
  })

  it("carries the ADR's columns with the right nullability and defaults", () => {
    const table = statements[0]
    expect(table).toMatch(/"?id"?\s+UUID\s+NOT NULL\s+DEFAULT gen_random_uuid\(\)\s+PRIMARY KEY/i)
    for (const column of ["workspace_id", "target_field_id", "source_field_id"]) expect(table).toMatch(new RegExp(`"?${column}"?\\s+UUID\\s+NOT NULL`, "i"))
    for (const column of ["target_object_type", "source_object_type"]) expect(table).toMatch(new RegExp(`"?${column}"?\\s+VARCHAR\\(50\\)\\s+NOT NULL`, "i"))
    expect(table).toMatch(/"?priority"?\s+INTEGER\s+NOT NULL\s+DEFAULT 0/i)
    expect(table).toMatch(/"?enabled"?\s+BOOLEAN\s+NOT NULL\s+DEFAULT true/i)
    expect(table).toMatch(/"?created_at"?\s+TIMESTAMP\(3\)\s+NOT NULL/i)
    expect(table).toMatch(/"?updated_at"?\s+TIMESTAMP\(3\)\s+NOT NULL/i)
    expect(table).toMatch(/"?created_by_id"?\s+UUID\s*,/i)
    expect(table).toMatch(/"?updated_by_id"?\s+UUID\s*,/i)
    expect(table).toMatch(/"?source"?\s+VARCHAR\(20\)\s+NOT NULL\s+DEFAULT 'UI'/i)
  })

  it("indexes (workspace, target field, priority) and (workspace, target field, source field) uniquely, and (workspace, target type)", () => {
    const joined = statements.slice(1).join("\n")
    expect(joined).toMatch(/UNIQUE INDEX ASYNC IF NOT EXISTS "?\w+"? ON "?custom_field_inheritance_rules"? \("?workspace_id"?, "?target_field_id"?, "?priority"?\)/i)
    expect(joined).toMatch(/UNIQUE INDEX ASYNC IF NOT EXISTS "?\w+"? ON "?custom_field_inheritance_rules"? \("?workspace_id"?, "?target_field_id"?, "?source_field_id"?\)/i)
    expect(joined).toMatch(/INDEX ASYNC IF NOT EXISTS "?\w+"? ON "?custom_field_inheritance_rules"? \("?workspace_id"?, "?target_object_type"?\)/i)
  })

  it("maps the same table with no relations and no @updatedAt (relationMode prisma, DSQL)", () => {
    const model = schema.match(/model CustomFieldInheritanceRule \{[\s\S]*?\n\}/)?.[0] ?? ""
    expect(model).toContain('@@map("custom_field_inheritance_rules")')
    expect(model).not.toContain("@relation")
    expect(model).not.toContain("@updatedAt")
    expect(model).toMatch(/@@unique\(\[workspaceId, targetFieldId, priority\]/)
    expect(model).toMatch(/@@unique\(\[workspaceId, targetFieldId, sourceFieldId\]/)
    expect(model).toMatch(/@@index\(\[workspaceId, targetObjectType\]/)
  })

  it("waits for its async indexes (both lists) and verifies before the receipt", () => {
    expect(runner).toMatch(/const ASYNC_WAIT_MIGRATIONS = \[[^\]]*"113_custom_field_inheritance_rules"/)
    expect(runner).toMatch(/\["049_agent_identity"[^\]]*"113_custom_field_inheritance_rules"[^\]]*\]\.includes\(migration\.name\)/)
    const assertion = runner.indexOf('migration.name === "113_custom_field_inheritance_rules") await assertCustomFieldInheritanceRulesMigration')
    expect(assertion).toBeGreaterThan(-1)
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'))
  })
})

/** A pg client double answering the two queries the postcondition issues. */
function fakeClient(options: { missingColumn?: string; wrongNullable?: string; indexes?: Record<string, Partial<{ valid: boolean; ready: boolean; unique: boolean; columns: string[] }> | null> } = {}) {
  const columns: Record<string, boolean> = {
    id: false, workspace_id: false, target_object_type: false, target_field_id: false, source_object_type: false, source_field_id: false,
    priority: false, enabled: false, created_at: false, updated_at: false, created_by_id: true, updated_by_id: true, source: false,
  }
  const good: Record<string, { unique: boolean; columns: string[] }> = {
    idx_cfir_target_priority: { unique: true, columns: ["workspace_id", "target_field_id", "priority"] },
    idx_cfir_target_source: { unique: true, columns: ["workspace_id", "target_field_id", "source_field_id"] },
    idx_cfir_workspace_target_type: { unique: false, columns: ["workspace_id", "target_object_type"] },
  }
  return {
    query: async (text: string, params: unknown[]) => {
      if (/information_schema\.columns/.test(text)) {
        return {
          rows: Object.entries(columns)
            .filter(([name]) => name !== options.missingColumn)
            .map(([name, nullable]) => ({ column_name: name, is_nullable: (name === options.wrongNullable ? !nullable : nullable) ? "YES" : "NO" })),
        }
      }
      const name = String(params[1])
      const override = options.indexes?.[name]
      if (override === null || !good[name]) return { rows: [] }
      return { rows: [{ valid: true, ready: true, unique: good[name].unique, table_name: "custom_field_inheritance_rules", columns: good[name].columns, predicate: null, expression: null, ...override }] }
    },
  } as never
}

describe("assertCustomFieldInheritanceRulesMigration", () => {
  it("passes for a fully built table", async () => {
    await expect(assertCustomFieldInheritanceRulesMigration(fakeClient(), "public")).resolves.toBeUndefined()
  })

  it("fails closed on a missing column or drifted nullability", async () => {
    await expect(assertCustomFieldInheritanceRulesMigration(fakeClient({ missingColumn: "priority" }), "public")).rejects.toThrow(/priority/)
    await expect(assertCustomFieldInheritanceRulesMigration(fakeClient({ wrongNullable: "workspace_id" }), "public")).rejects.toThrow(/workspace_id/)
  })

  it("fails closed when an async index is invalid, not ready, missing, or has drifted", async () => {
    await expect(assertCustomFieldInheritanceRulesMigration(fakeClient({ indexes: { idx_cfir_target_priority: { valid: false } } }), "public")).rejects.toThrow(/idx_cfir_target_priority/)
    await expect(assertCustomFieldInheritanceRulesMigration(fakeClient({ indexes: { idx_cfir_target_source: { ready: false } } }), "public")).rejects.toThrow(/idx_cfir_target_source/)
    await expect(assertCustomFieldInheritanceRulesMigration(fakeClient({ indexes: { idx_cfir_workspace_target_type: null } }), "public")).rejects.toThrow(/idx_cfir_workspace_target_type/)
    await expect(assertCustomFieldInheritanceRulesMigration(fakeClient({ indexes: { idx_cfir_target_priority: { unique: false } } }), "public")).rejects.toThrow(/idx_cfir_target_priority/)
  })
})
