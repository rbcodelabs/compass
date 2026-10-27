import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

/** Static guards for 111_agent_run_credential_source: the SQL file is what reaches Aurora DSQL / Postgres. */
const ROOT = process.cwd()
const NAME = "111_agent_run_credential_source"
const runner = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8")
const manifest = readFileSync(path.join(ROOT, "lib/preview-automation/managed-manifest.ts"), "utf-8")
const sqlPath = path.join(ROOT, "prisma/migrations", NAME, "migration.sql")
const raw = existsSync(sqlPath) ? readFileSync(sqlPath, "utf-8") : ""
const sql = raw.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n")
const statements = sql.split(";").map((s) => s.trim()).filter(Boolean)
const agentRunModel = schema.match(/model AgentRun \{[\s\S]*?\n\}/)?.[0] ?? ""

describe(NAME, () => {
  it("is registered exactly once, after the 110 migrations", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${NAME}"`, "g"))]).toHaveLength(1)
    expect(existsSync(sqlPath)).toBe(true)
    expect(runner.indexOf(`name: "${NAME}"`)).toBeGreaterThan(runner.indexOf('name: "110_agent_sandbox_class"'))
  })

  it("is one idempotent nullable ADD COLUMN with no default, constraint, index or foreign key (DSQL rules)", () => {
    expect(statements).toEqual(["ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS credential_source VARCHAR(30)"])
    expect(sql).not.toMatch(/NOT NULL|DEFAULT|REFERENCES|CREATE (UNIQUE )?INDEX|CREATE TYPE|CREATE TRIGGER|DROP|\bUPDATE\b|\bINSERT\b/i)
  })

  it("is mirrored in schema.prisma as a nullable VarChar(30) with the same column name", () => {
    expect(agentRunModel).toMatch(/credentialSource\s+String\?\s+@map\("credential_source"\) @db\.VarChar\(30\)/)
  })

  it("has a runner postcondition that proves the column exists before the receipt", () => {
    const block = runner.slice(runner.indexOf(`migration.name === "${NAME}"`))
    expect(block.slice(0, 500)).toContain("credential_source")
    expect(block.slice(0, 500)).toMatch(/!== "1"/)
  })

  it("is pinned in the reviewed managed manifest with the digest of the shipped SQL", () => {
    const digest = createHash("sha256").update(raw).digest("hex")
    expect(manifest).toContain(`"${NAME}": "${digest}"`)
  })
})
