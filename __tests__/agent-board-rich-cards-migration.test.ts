import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  AGENT_BOARD_RICH_CARDS_MIGRATION,
  assertAgentBoardRichCardsMigration,
} from "@/lib/migrations/agent-board-rich-cards"
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

describe("119_agent_board_rich_cards registration and manifest", () => {
  it("registers 119_agent_board_rich_cards once after 118_doc_kind_backfill and passes reviewed manifest gate", () => {
    expect(AGENT_BOARD_RICH_CARDS_MIGRATION).toBe("119_agent_board_rich_cards")
    expect(names.filter((n) => n === AGENT_BOARD_RICH_CARDS_MIGRATION)).toHaveLength(1)
    expect(names.indexOf(AGENT_BOARD_RICH_CARDS_MIGRATION)).toBeGreaterThan(names.indexOf("118_doc_kind_backfill"))
    expect(Object.keys(REVIEWED_MIGRATION_CODE_SHA256[AGENT_BOARD_RICH_CARDS_MIGRATION] ?? {})).toEqual([
      "lib/migrations/agent-board-rich-cards.ts",
    ])
    const entries = partitionPendingMigrations("compass_pr_570_aaaaaaaaaaaa", new Set()).pending
    expect(() => assertReviewedManagedManifest(entries)).not.toThrow()
  })

  it("runs assertAgentBoardRichCardsMigration before writing the completion receipt", () => {
    const receipt = runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP')
    const hook = runner.indexOf("if (migration.name === AGENT_BOARD_RICH_CARDS_MIGRATION) await assertAgentBoardRichCardsMigration")
    expect(hook).toBeGreaterThan(-1)
    expect(hook).toBeLessThan(receipt)
  })

  it("adds five nullable columns with DSQL-safe idempotent DDL and matches schema.prisma", () => {
    const stmts = executableStatements(AGENT_BOARD_RICH_CARDS_MIGRATION)
    expect(stmts).toEqual([
      "ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS squad_id UUID",
      "ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS summary VARCHAR(500)",
      "ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS pr_url VARCHAR(500)",
      "ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS substatus VARCHAR(20)",
      "ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS current_activity VARCHAR(240)",
    ])
    expect(stmts.join(";\n")).not.toMatch(/NOT NULL|DEFAULT|REFERENCES|FOREIGN KEY|CHECK|INDEX|UPDATE|INSERT|DROP/i)

    const convoModel = schema.match(/model AgentConversation \{[\s\S]*?\n\}/)?.[0] ?? ""
    expect(convoModel).toMatch(/squadId\s+String\?\s+@map\("squad_id"\)\s+@db\.Uuid/)
    expect(convoModel).toMatch(/summary\s+String\?\s+@db\.VarChar\(500\)/)
    expect(convoModel).toMatch(/prUrl\s+String\?\s+@map\("pr_url"\)\s+@db\.VarChar\(500\)/)

    const runModel = schema.match(/model AgentRun \{[\s\S]*?\n\}/)?.[0] ?? ""
    expect(runModel).toMatch(/substatus\s+String\?\s+@db\.VarChar\(20\)/)
    expect(runModel).toMatch(/currentActivity\s+String\?\s+@map\("current_activity"\)\s+@db\.VarChar\(240\)/)
  })
})

type ColRow = { table_name: string; column_name: string; data_type: string; is_nullable: string }
const validRows: ColRow[] = [
  { table_name: "agent_conversations", column_name: "squad_id", data_type: "uuid", is_nullable: "YES" },
  { table_name: "agent_conversations", column_name: "summary", data_type: "character varying", is_nullable: "YES" },
  { table_name: "agent_conversations", column_name: "pr_url", data_type: "character varying", is_nullable: "YES" },
  { table_name: "agent_runs", column_name: "substatus", data_type: "character varying", is_nullable: "YES" },
  { table_name: "agent_runs", column_name: "current_activity", data_type: "character varying", is_nullable: "YES" },
]
const clientFor = (rows: ColRow[]) => ({ query: async () => ({ rows }) }) as never

describe("assertAgentBoardRichCardsMigration", () => {
  it("accepts all five nullable columns with expected types", async () => {
    await expect(assertAgentBoardRichCardsMigration(clientFor(validRows), "compass_dev")).resolves.toBeUndefined()
  })

  it("fails closed on missing, mistyped, or NOT NULL columns", async () => {
    await expect(assertAgentBoardRichCardsMigration(clientFor(validRows.slice(1)), "compass_dev")).rejects.toThrow(
      /agent_conversations\.squad_id missing/,
    )
    await expect(
      assertAgentBoardRichCardsMigration(
        clientFor(validRows.map((r) => (r.column_name === "squad_id" ? { ...r, data_type: "text" } : r))),
        "compass_dev",
      ),
    ).rejects.toThrow(/type postcondition/)
    await expect(
      assertAgentBoardRichCardsMigration(
        clientFor(validRows.map((r) => (r.column_name === "current_activity" ? { ...r, is_nullable: "NO" } : r))),
        "compass_dev",
      ),
    ).rejects.toThrow(/NOT NULL/)
  })
})
