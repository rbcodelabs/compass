import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

/** Static guards for 110_workspace_anthropic_api_key: the SQL file is what reaches Aurora DSQL / Postgres. */
const ROOT = process.cwd()
const NAME = "110_workspace_anthropic_api_key"
const runner = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8")
const sqlPath = path.join(ROOT, "prisma/migrations", NAME, "migration.sql")
const sql = existsSync(sqlPath) ? readFileSync(sqlPath, "utf-8").split("\n").map((line) => line.replace(/--.*$/, "")).join("\n") : ""
const statements = sql.split(";").map((s) => s.trim()).filter(Boolean)

describe(NAME, () => {
  it("is registered exactly once, after 109", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${NAME}"`, "g"))]).toHaveLength(1)
    expect(existsSync(sqlPath)).toBe(true)
    expect(runner.indexOf(`name: "${NAME}"`)).toBeGreaterThan(runner.indexOf('name: "109_agent_conversation_reviews"'))
  })

  it("is two idempotent nullable ADD COLUMNs, one DDL per statement, with no default, constraint, index or foreign key (DSQL rules)", () => {
    expect(statements).toEqual([
      "ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS anthropic_api_key_encrypted TEXT",
      "ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS anthropic_api_key_last4 TEXT",
    ])
    expect(sql).not.toMatch(/NOT NULL|DEFAULT|REFERENCES|CREATE (UNIQUE )?INDEX|CREATE TYPE|CREATE TRIGGER|DROP/i)
  })

  it("is mirrored in schema.prisma on Workspace, as nullable text with the same column names", () => {
    expect(schema).toMatch(/anthropicApiKeyEncrypted\s+String\?\s+@map\("anthropic_api_key_encrypted"\) @db\.Text/)
    expect(schema).toMatch(/anthropicApiKeyLast4\s+String\?\s+@map\("anthropic_api_key_last4"\) @db\.Text/)
  })

  it("has a runner postcondition that proves both columns exist before the receipt", () => {
    const block = runner.slice(runner.indexOf(`migration.name === "${NAME}"`))
    expect(block.slice(0, 700)).toContain("anthropic_api_key_encrypted")
    expect(block.slice(0, 700)).toContain("anthropic_api_key_last4")
    expect(block.slice(0, 700)).toMatch(/!== "2"/)
  })
})
