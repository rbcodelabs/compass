import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { WORK_ITEM_REGISTRY, WORK_ITEM_TYPES } from "@/lib/work-item-ids"
import { expectedWorkItemIndexes } from "@/lib/migrations/work-item-ids"

/**
 * Static guards for 092_work_item_ids. The DDL that reaches Aurora DSQL is the SQL file, not
 * schema.prisma, so the two are pinned to each other here.
 */
const ROOT = process.cwd()
const NAME = "092_work_item_ids"
const runner = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8")
const sqlPath = path.join(ROOT, "prisma/migrations", NAME, "migration.sql")
const sql = existsSync(sqlPath)
  ? readFileSync(sqlPath, "utf-8").split("\n").map((line) => line.replace(/--.*$/, "")).join("\n")
  : ""
// Same split the runner uses.
const statements = sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)
const tables = WORK_ITEM_TYPES.map((type) => WORK_ITEM_REGISTRY[type].table)

function model(table: string): string {
  const match = [...schema.matchAll(/model \w+ \{[\s\S]*?\n\}/g)].find((m) => m[0].includes(`@@map("${table}")`))
  return match?.[0] ?? ""
}

describe(NAME, () => {
  it("is registered exactly once, after 091", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${NAME}"`, "g"))]).toHaveLength(1)
    expect(existsSync(sqlPath)).toBe(true)
    expect(runner.indexOf(`name: "${NAME}"`)).toBeGreaterThan(runner.indexOf('name: "091_entity_links"'))
  })

  it("adds seq_prefix and seq_number to every work item table, nullable, one DDL each", () => {
    for (const table of tables) {
      expect(statements).toContain(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS seq_prefix VARCHAR(8)`)
      expect(statements).toContain(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS seq_number INTEGER`)
    }
  })

  it("adds nullable workspace_id to key_results and assumptions only", () => {
    const additions = statements.filter((s) => /ADD COLUMN IF NOT EXISTS workspace_id/.test(s))
    expect(additions.sort()).toEqual([
      "ALTER TABLE assumptions ADD COLUMN IF NOT EXISTS workspace_id UUID",
      "ALTER TABLE key_results ADD COLUMN IF NOT EXISTS workspace_id UUID",
    ])
  })

  it("creates one unique async index per table on (workspace_id, seq_prefix, seq_number)", () => {
    for (const table of tables) {
      expect(statements).toContain(
        `CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_${table}_seq ON ${table}(workspace_id, seq_prefix, seq_number)`,
      )
    }
    expect(statements.filter((s) => /^CREATE UNIQUE INDEX/.test(s))).toHaveLength(14)
  })

  it("creates the counter table with a composite primary key and no foreign keys", () => {
    const table = statements.find((s) => s.startsWith("CREATE TABLE IF NOT EXISTS workspace_sequences")) ?? ""
    expect(table).toMatch(/workspace_id\s+UUID\s+NOT NULL/)
    expect(table).toMatch(/entity_type\s+VARCHAR\(40\)\s+NOT NULL/)
    expect(table).toMatch(/next_value\s+INTEGER\s+NOT NULL\s+DEFAULT\s+1/)
    expect(table).toMatch(/PRIMARY KEY \(workspace_id, entity_type\)/)
  })

  it("follows DSQL rules: idempotent, no FK, enum, trigger, partial index, ASC/DESC, NOT NULL/DEFAULT on ADD COLUMN, or DML", () => {
    expect(sql).not.toMatch(/REFERENCES|CREATE TYPE|CREATE TRIGGER|\bWHERE\b|SERIAL|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bASC\b|\bDESC\b/i)
    for (const statement of statements) {
      expect(statement).toMatch(/IF NOT EXISTS/)
      if (/ADD COLUMN/.test(statement)) expect(statement).not.toMatch(/NOT NULL|DEFAULT/)
      if (/^CREATE .*INDEX/.test(statement)) expect(statement).toMatch(/INDEX ASYNC/)
      // One DDL per statement.
      expect(statement).not.toContain(";")
    }
  })

  it("maps the same columns and indexes in schema.prisma", () => {
    for (const table of tables) {
      const body = model(table)
      expect(body, table).toContain('seqPrefix String? @map("seq_prefix") @db.VarChar(8)')
      expect(body, table).toContain('seqNumber Int? @map("seq_number")')
      expect(body, table).toContain(`@@unique([workspaceId, seqPrefix, seqNumber], map: "idx_${table}_seq")`)
    }
    for (const table of ["key_results", "assumptions"]) {
      expect(model(table)).toContain('workspaceId String? @map("workspace_id") @db.Uuid')
      expect(model(table)).toContain(`@@index([workspaceId], map: "idx_${table}_workspace_id")`)
    }
    const counter = schema.match(/model WorkspaceSequence \{[\s\S]*?\n\}/)?.[0] ?? ""
    expect(counter).toContain('@@id([workspaceId, entityType])')
    expect(counter).toContain('@@map("workspace_sequences")')
    expect(counter).not.toMatch(/@relation/)
  })

  it("lists in the postcondition every index the SQL creates", () => {
    const created = [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX ASYNC IF NOT EXISTS (\w+) ON/g)].map((m) => m[1]).sort()
    expect(expectedWorkItemIndexes().map((i) => i.name).sort()).toEqual(created)
  })

  it("waits for its async indexes and verifies before the receipt", () => {
    expect(runner).toMatch(/const ASYNC_WAIT_MIGRATIONS = \[[^\]]*"092_work_item_ids"/)
    expect(runner).toMatch(/\["049_agent_identity"[^\]]*"092_work_item_ids"[^\]]*\]\.includes\(migration\.name\)/)
    const assertion = runner.indexOf("await assertWorkItemIdsMigration(client, schema)")
    expect(assertion).toBeGreaterThan(-1)
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'))
  })

  it("is pinned in the managed manifest (SQL and postcondition hook)", () => {
    const manifest = readFileSync(path.join(ROOT, "lib/preview-automation/managed-manifest.ts"), "utf-8")
    const digest = createHash("sha256").update(readFileSync(sqlPath)).digest("hex")
    expect(manifest).toContain(`"${NAME}": "${digest}"`)
    const hook = createHash("sha256").update(readFileSync(path.join(ROOT, "lib/migrations/work-item-ids.ts"))).digest("hex")
    expect(manifest).toContain(`"lib/migrations/work-item-ids.ts": "${hook}"`)
  })
})
