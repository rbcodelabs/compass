import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  AGENT_CHILD_RUNS_MIGRATION,
  assertAgentChildRunsMigration,
} from "@/lib/migrations/agent-child-runs"
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

describe("120_agent_child_runs registration and manifest", () => {
  it("registers 120_agent_child_runs once after 119_agent_board_rich_cards and passes reviewed manifest gate", () => {
    expect(AGENT_CHILD_RUNS_MIGRATION).toBe("120_agent_child_runs")
    expect(names.filter((n) => n === AGENT_CHILD_RUNS_MIGRATION)).toHaveLength(1)
    expect(names.indexOf(AGENT_CHILD_RUNS_MIGRATION)).toBeGreaterThan(names.indexOf("119_agent_board_rich_cards"))
    expect(Object.keys(REVIEWED_MIGRATION_CODE_SHA256[AGENT_CHILD_RUNS_MIGRATION] ?? {})).toEqual([
      "lib/migrations/agent-child-runs.ts",
    ])
    const entries = partitionPendingMigrations("compass_pr_575_aaaaaaaaaaaa", new Set()).pending
    expect(() => assertReviewedManagedManifest(entries)).not.toThrow()
  })

  it("registers in ASYNC_WAIT_MIGRATIONS and runs assertAgentChildRunsMigration before writing the completion receipt", () => {
    expect(runner).toMatch(/ASYNC_WAIT_MIGRATIONS[\s\S]*?"120_agent_child_runs"/)
    const receipt = runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP')
    const hook = runner.indexOf("if (migration.name === AGENT_CHILD_RUNS_MIGRATION) await assertAgentChildRunsMigration")
    expect(hook).toBeGreaterThan(-1)
    expect(hook).toBeLessThan(receipt)
  })

  it("uses DSQL-safe CREATE TABLE IF NOT EXISTS and CREATE INDEX ASYNC IF NOT EXISTS with zero FKs", () => {
    const stmts = executableStatements(AGENT_CHILD_RUNS_MIGRATION)
    expect(stmts).toHaveLength(4)
    expect(stmts[0]).toMatch(/^CREATE TABLE IF NOT EXISTS agent_child_runs/i)
    expect(stmts[1]).toMatch(/^CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_agent_child_runs_run_native/i)
    expect(stmts[2]).toMatch(/^CREATE INDEX ASYNC IF NOT EXISTS idx_agent_child_runs_conversation_started/i)
    expect(stmts[3]).toMatch(/^CREATE INDEX ASYNC IF NOT EXISTS idx_agent_child_runs_workspace_conversation/i)
    expect(stmts.join(";\n")).not.toMatch(/REFERENCES|FOREIGN KEY|SERIAL|BIGSERIAL|TRIGGER|JSONB/i)

    const model = schema.match(/model AgentChildRun \{[\s\S]*?\n\}/)?.[0] ?? ""
    expect(model).toContain('@@map("agent_child_runs")')
    expect(model).toContain('@@unique([runId, nativeAgentId], map: "idx_agent_child_runs_run_native")')
    expect(model).toContain('@@index([conversationId, startedAt], map: "idx_agent_child_runs_conversation_started")')
    expect(model).toContain('@@index([workspaceId, conversationId], map: "idx_agent_child_runs_workspace_conversation")')
  })
})

type ColumnRow = { column_name: string; data_type: string; is_nullable: string }
type IndexRow = {
  index_name: string
  table_name: string
  valid: boolean
  ready: boolean
  unique: boolean
  columns: string[]
  predicate: string | null
  expression: string | null
}

const validColumns: ColumnRow[] = [
  { column_name: "id", data_type: "uuid", is_nullable: "NO" },
  { column_name: "conversation_id", data_type: "uuid", is_nullable: "NO" },
  { column_name: "run_id", data_type: "uuid", is_nullable: "NO" },
  { column_name: "workspace_id", data_type: "uuid", is_nullable: "NO" },
  { column_name: "native_agent_id", data_type: "character varying", is_nullable: "NO" },
  { column_name: "parent_child_run_id", data_type: "uuid", is_nullable: "YES" },
  { column_name: "parent_native_agent_id", data_type: "character varying", is_nullable: "YES" },
  { column_name: "role", data_type: "character varying", is_nullable: "NO" },
  { column_name: "description", data_type: "character varying", is_nullable: "NO" },
  { column_name: "status", data_type: "character varying", is_nullable: "NO" },
  { column_name: "current_activity", data_type: "character varying", is_nullable: "YES" },
  { column_name: "step_count", data_type: "integer", is_nullable: "NO" },
  { column_name: "steps_json", data_type: "text", is_nullable: "YES" },
  { column_name: "result_summary", data_type: "text", is_nullable: "YES" },
  { column_name: "started_at", data_type: "timestamp without time zone", is_nullable: "NO" },
  { column_name: "finished_at", data_type: "timestamp without time zone", is_nullable: "YES" },
  { column_name: "created_at", data_type: "timestamp without time zone", is_nullable: "NO" },
  { column_name: "updated_at", data_type: "timestamp without time zone", is_nullable: "NO" },
]

const validIndexes: IndexRow[] = [
  {
    index_name: "idx_agent_child_runs_run_native",
    table_name: "agent_child_runs",
    valid: true,
    ready: true,
    unique: true,
    columns: ["run_id", "native_agent_id"],
    predicate: null,
    expression: null,
  },
  {
    index_name: "idx_agent_child_runs_conversation_started",
    table_name: "agent_child_runs",
    valid: true,
    ready: true,
    unique: false,
    columns: ["conversation_id", "started_at"],
    predicate: null,
    expression: null,
  },
  {
    index_name: "idx_agent_child_runs_workspace_conversation",
    table_name: "agent_child_runs",
    valid: true,
    ready: true,
    unique: false,
    columns: ["workspace_id", "conversation_id"],
    predicate: null,
    expression: null,
  },
]

const clientFor = (cols: ColumnRow[], idxs: IndexRow[]) =>
  ({
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("information_schema.columns")) return { rows: cols }
      const name = params?.[1]
      return { rows: idxs.filter((idx) => idx.index_name === name) }
    },
  }) as never

describe("assertAgentChildRunsMigration", () => {
  it("accepts valid agent_child_runs columns and ready/valid indexes", async () => {
    await expect(assertAgentChildRunsMigration(clientFor(validColumns, validIndexes), "compass_dev")).resolves.toBeUndefined()
  })

  it("fails closed on missing columns, mistyped columns, or unready/invalid indexes", async () => {
    await expect(
      assertAgentChildRunsMigration(clientFor(validColumns.slice(1), validIndexes), "compass_dev"),
    ).rejects.toThrow(/agent_child_runs\.id missing/)

    await expect(
      assertAgentChildRunsMigration(
        clientFor(
          validColumns.map((c) => (c.column_name === "step_count" ? { ...c, data_type: "bigint" } : c)),
          validIndexes,
        ),
        "compass_dev",
      ),
    ).rejects.toThrow(/type postcondition/)

    await expect(
      assertAgentChildRunsMigration(
        clientFor(
          validColumns,
          validIndexes.map((idx) => (idx.index_name === "idx_agent_child_runs_run_native" ? { ...idx, ready: false } : idx)),
        ),
        "compass_dev",
      ),
    ).rejects.toThrow(/index postcondition failed/)
  })
})
