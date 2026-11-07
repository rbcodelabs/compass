import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

/** Static guards for 112_agent_conversation_archive: the SQL file is what reaches DSQL, so pin it to schema.prisma. */
const ROOT = process.cwd()
const NAME = "112_agent_conversation_archive"
const runner = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8")
const sql = readFileSync(path.join(ROOT, "prisma/migrations", NAME, "migration.sql"), "utf-8")
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n")
const statements = sql.split(";").map((s) => s.trim()).filter(Boolean)

describe(NAME, () => {
  it("is registered exactly once, after 111", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${NAME}"`, "g"))]).toHaveLength(1)
    expect(runner.indexOf(`name: "${NAME}"`)).toBeGreaterThan(runner.indexOf('name: "111_agent_git_author"'))
  })

  it("is one bare nullable idempotent column (DSQL: no default, no constraint)", () => {
    expect(statements).toEqual(["ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP(3)"])
  })

  it("matches the Prisma model", () => {
    expect(schema).toMatch(/model AgentConversation \{[^}]*archivedAt\s+DateTime\?\s+@map\("archived_at"\)/)
  })
})
