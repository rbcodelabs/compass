import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"

/**
 * Static guards for 091_entity_links. The DDL that reaches Aurora DSQL is the SQL file, not
 * schema.prisma, so the two are pinned to each other here.
 */
const ROOT = process.cwd()
const NAME = "091_entity_links"
const runner = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8")
const sqlPath = path.join(ROOT, "prisma/migrations", NAME, "migration.sql")
const sql = existsSync(sqlPath)
  ? readFileSync(sqlPath, "utf-8").split("\n").map((line) => line.replace(/--.*$/, "")).join("\n")
  : ""
const statements = sql.split(";").map((s) => s.trim()).filter(Boolean)

describe(NAME, () => {
  it("is registered exactly once, after 090", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${NAME}"`, "g"))]).toHaveLength(1)
    expect(existsSync(sqlPath)).toBe(true)
    expect(runner.indexOf(`name: "${NAME}"`)).toBeGreaterThan(runner.indexOf('name: "090_v0_chat_artifacts"'))
  })

  it("is one idempotent table then three async indexes, one DDL statement each", () => {
    expect(statements).toHaveLength(4)
    expect(statements[0]).toMatch(/^CREATE TABLE IF NOT EXISTS entity_links\s*\(/i)
    expect(statements[1]).toMatch(
      /^CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_entity_links_pair ON entity_links\(from_id, link_type, to_id\)$/i,
    )
    expect(statements[2]).toMatch(
      /^CREATE INDEX ASYNC IF NOT EXISTS idx_entity_links_reverse ON entity_links\(to_id, link_type, from_id\)$/i,
    )
    expect(statements[3]).toMatch(
      /^CREATE INDEX ASYNC IF NOT EXISTS idx_entity_links_workspace ON entity_links\(workspace_id, link_type\)$/i,
    )
  })

  it("uses no foreign keys, enums, triggers, partial indexes, ASC/DESC or backfill", () => {
    expect(sql).not.toMatch(/REFERENCES|CREATE TYPE|CREATE TRIGGER|\bWHERE\b|SERIAL|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bASC\b|\bDESC\b|ALTER TABLE/i)
  })

  it("carries the specified columns, with only created_by_id and attrs nullable", () => {
    const table = statements[0]
    expect(table).toMatch(/id\s+UUID\s+PRIMARY KEY\s+DEFAULT\s+gen_random_uuid\(\)/i)
    expect(table).toMatch(/workspace_id\s+UUID\s+NOT NULL/i)
    expect(table).toMatch(/link_type\s+VARCHAR\(60\)\s+NOT NULL/i)
    expect(table).toMatch(/from_type\s+VARCHAR\(40\)\s+NOT NULL/i)
    expect(table).toMatch(/from_id\s+UUID\s+NOT NULL/i)
    expect(table).toMatch(/to_type\s+VARCHAR\(40\)\s+NOT NULL/i)
    expect(table).toMatch(/to_id\s+UUID\s+NOT NULL/i)
    expect(table).toMatch(/origin\s+VARCHAR\(20\)\s+NOT NULL\s+DEFAULT\s+'DIRECT'/i)
    expect(table).toMatch(/source\s+VARCHAR\(20\)\s+NOT NULL\s+DEFAULT\s+'UI'/i)
    expect(table).toMatch(/created_by_id\s+UUID,/i)
    expect(table).toMatch(/attrs\s+TEXT,/i)
    expect(table).toMatch(/created_at\s+TIMESTAMP\(3\)\s+NOT NULL\s+DEFAULT\s+CURRENT_TIMESTAMP/i)
    expect(table).toMatch(/updated_at\s+TIMESTAMP\(3\)\s+NOT NULL\s+DEFAULT\s+CURRENT_TIMESTAMP/i)
  })

  it("maps the same table and indexes in schema.prisma, with no relations or @updatedAt", () => {
    const model = schema.match(/model EntityLink \{[\s\S]*?\n\}/)?.[0] ?? ""
    expect(model).toContain('@@map("entity_links")')
    expect(model).toContain('@@unique([fromId, linkType, toId], map: "idx_entity_links_pair")')
    expect(model).toContain('@@index([toId, linkType, fromId], map: "idx_entity_links_reverse")')
    expect(model).toContain('@@index([workspaceId, linkType], map: "idx_entity_links_workspace")')
    expect(model).not.toMatch(/@relation|@updatedAt/)
  })

  it("waits for its async indexes and verifies before the receipt", () => {
    expect(runner).toMatch(/const ASYNC_WAIT_MIGRATIONS = \[[^\]]*"091_entity_links"/)
    expect(runner).toMatch(/\["049_agent_identity"[^\]]*"091_entity_links"[^\]]*\]\.includes\(migration\.name\)/)
    const assertion = runner.indexOf('migration.name === "091_entity_links") await assertEntityLinksMigration')
    expect(assertion).toBeGreaterThan(-1)
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'))
  })

  it("is pinned in the managed manifest (SQL and postcondition hook)", () => {
    const manifest = readFileSync(path.join(ROOT, "lib/preview-automation/managed-manifest.ts"), "utf-8")
    const digest = createHash("sha256").update(readFileSync(sqlPath)).digest("hex")
    expect(manifest).toContain(`"${NAME}": "${digest}"`)
    const hook = createHash("sha256").update(readFileSync(path.join(ROOT, "lib/migrations/entity-links.ts"))).digest("hex")
    expect(manifest).toContain(`"lib/migrations/entity-links.ts": "${hook}"`)
  })

  it("has no application readers or writers yet (phase 1)", () => {
    const files = ["lib/db.ts", "lib/links.ts"].filter((f) => existsSync(path.join(ROOT, f)))
    for (const f of files) expect(readFileSync(path.join(ROOT, f), "utf-8")).not.toMatch(/entityLink|entity_links/)
  })
})
