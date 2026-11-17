import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  UNIFIED_CONVERSATIONS_MIGRATION,
  assertUnifiedConversationsMigration,
} from "@/lib/migrations/unified-conversations"
import {
  REVIEWED_MIGRATION_CODE_SHA256,
  assertReviewedManagedManifest,
} from "@/lib/preview-automation/managed-manifest"
import { partitionPendingMigrations } from "@/lib/migrations/runner"

const ROOT = process.cwd()
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf-8")
const runner = read("lib/migrations/runner.ts")
const schema = read("prisma/schema.prisma")
const executableStatements = (name: string) =>
  read(`prisma/migrations/${name}/migration.sql`)
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
const names = [...runner.matchAll(/name:\s*"(\d{3}_[a-z0-9_]+)"/g)].map((match) => match[1])

describe("125_unified_conversations registration and manifest", () => {
  it("registers 125_unified_conversations once after 124_agent_web_fetches and passes reviewed manifest gate", () => {
    expect(UNIFIED_CONVERSATIONS_MIGRATION).toBe("125_unified_conversations")
    expect(names.filter((n) => n === UNIFIED_CONVERSATIONS_MIGRATION)).toHaveLength(1)
    expect(names.indexOf(UNIFIED_CONVERSATIONS_MIGRATION)).toBeGreaterThan(names.indexOf("124_agent_web_fetches"))
    expect(Object.keys(REVIEWED_MIGRATION_CODE_SHA256[UNIFIED_CONVERSATIONS_MIGRATION] ?? {})).toEqual([
      "lib/migrations/unified-conversations.ts",
    ])
    const entries = partitionPendingMigrations("compass_pr_570_aaaaaaaaaaaa", new Set()).pending
    expect(() => assertReviewedManagedManifest(entries)).not.toThrow()
  })

  it("runs assertUnifiedConversationsMigration before writing the completion receipt", () => {
    const receipt = runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP')
    const hook = runner.indexOf("if (migration.name === UNIFIED_CONVERSATIONS_MIGRATION) await assertUnifiedConversationsMigration")
    expect(hook).toBeGreaterThan(-1)
    expect(hook).toBeLessThan(receipt)
  })

  it("adds twelve nullable columns with DSQL-safe idempotent DDL and matches schema.prisma", () => {
    const stmts = executableStatements(UNIFIED_CONVERSATIONS_MIGRATION)
    expect(stmts).toEqual([
      "ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS target_type VARCHAR(40)",
      "ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS target_id UUID",
      "ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS visibility VARCHAR(20)",
      "ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS status VARCHAR(20)",
      "ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS agent_mode VARCHAR(20)",
      "ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS source VARCHAR(20)",
      "ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP(3)",
      "ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS resolved_by_id UUID",
      "ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS author_name VARCHAR(255)",
      "ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS author_type VARCHAR(20)",
      "ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS message_kind VARCHAR(30)",
      "ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP(3)",
    ])
    expect(stmts.join(";\n")).not.toMatch(/NOT NULL|DEFAULT|REFERENCES|FOREIGN KEY|CHECK|INDEX|UPDATE|INSERT|DROP/i)

    const convoModel = schema.match(/model AgentConversation \{[\s\S]*?\n\}/)?.[0] ?? ""
    expect(convoModel).toMatch(/targetType\s+String\?\s+@map\("target_type"\)\s+@db\.VarChar\(40\)/)
    expect(convoModel).toMatch(/targetId\s+String\?\s+@map\("target_id"\)\s+@db\.Uuid/)
    expect(convoModel).toMatch(/visibility\s+String\?\s+@db\.VarChar\(20\)/)
    expect(convoModel).toMatch(/status\s+String\?\s+@db\.VarChar\(20\)/)
    expect(convoModel).toMatch(/agentMode\s+String\?\s+@map\("agent_mode"\)\s+@db\.VarChar\(20\)/)
    expect(convoModel).toMatch(/source\s+String\?\s+@db\.VarChar\(20\)/)
    expect(convoModel).toMatch(/resolvedAt\s+DateTime\?\s+@map\("resolved_at"\)/)
    expect(convoModel).toMatch(/resolvedById\s+String\?\s+@map\("resolved_by_id"\)\s+@db\.Uuid/)

    const msgModel = schema.match(/model AgentMessage \{[\s\S]*?\n\}/)?.[0] ?? ""
    expect(msgModel).toMatch(/authorName\s+String\?\s+@map\("author_name"\)\s+@db\.VarChar\(255\)/)
    expect(msgModel).toMatch(/authorType\s+String\?\s+@map\("author_type"\)\s+@db\.VarChar\(20\)/)
    expect(msgModel).toMatch(/messageKind\s+String\?\s+@map\("message_kind"\)\s+@db\.VarChar\(30\)/)
    expect(msgModel).toMatch(/editedAt\s+DateTime\?\s+@map\("edited_at"\)/)
  })
})

type ColRow = { table_name: string; column_name: string; data_type: string; is_nullable: string }
const validRows: ColRow[] = [
  { table_name: "agent_conversations", column_name: "target_type", data_type: "character varying", is_nullable: "YES" },
  { table_name: "agent_conversations", column_name: "target_id", data_type: "uuid", is_nullable: "YES" },
  { table_name: "agent_conversations", column_name: "visibility", data_type: "character varying", is_nullable: "YES" },
  { table_name: "agent_conversations", column_name: "status", data_type: "character varying", is_nullable: "YES" },
  { table_name: "agent_conversations", column_name: "agent_mode", data_type: "character varying", is_nullable: "YES" },
  { table_name: "agent_conversations", column_name: "source", data_type: "character varying", is_nullable: "YES" },
  { table_name: "agent_conversations", column_name: "resolved_at", data_type: "timestamp without time zone", is_nullable: "YES" },
  { table_name: "agent_conversations", column_name: "resolved_by_id", data_type: "uuid", is_nullable: "YES" },
  { table_name: "agent_messages", column_name: "author_name", data_type: "character varying", is_nullable: "YES" },
  { table_name: "agent_messages", column_name: "author_type", data_type: "character varying", is_nullable: "YES" },
  { table_name: "agent_messages", column_name: "message_kind", data_type: "character varying", is_nullable: "YES" },
  { table_name: "agent_messages", column_name: "edited_at", data_type: "timestamp without time zone", is_nullable: "YES" },
]
const clientFor = (rows: ColRow[]) => ({ query: async () => ({ rows }) }) as never

describe("assertUnifiedConversationsMigration", () => {
  it("accepts all twelve nullable columns with expected types", async () => {
    await expect(assertUnifiedConversationsMigration(clientFor(validRows), "compass_dev")).resolves.toBeUndefined()
  })

  it("fails closed on missing, mistyped, or NOT NULL columns", async () => {
    await expect(assertUnifiedConversationsMigration(clientFor(validRows.slice(1)), "compass_dev")).rejects.toThrow(
      /agent_conversations\.target_type missing/,
    )
    await expect(
      assertUnifiedConversationsMigration(
        clientFor(validRows.map((r) => (r.column_name === "target_id" ? { ...r, data_type: "text" } : r))),
        "compass_dev",
      ),
    ).rejects.toThrow(/type postcondition/)
    await expect(
      assertUnifiedConversationsMigration(
        clientFor(validRows.map((r) => (r.column_name === "author_name" ? { ...r, is_nullable: "NO" } : r))),
        "compass_dev",
      ),
    ).rejects.toThrow(/NOT NULL/)
  })
})
