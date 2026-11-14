import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import type { PoolClient } from "pg"
import {
  AGENT_INBOX_ITEMS_TABLE,
  AGENT_INTERACTIVE_CONTROLS_INDEXES,
  AGENT_INTERACTIVE_CONTROLS_MIGRATION,
  AGENT_SCHEDULED_WAKEUPS_TABLE,
  assertAgentInteractiveControlsMigration,
} from "@/lib/migrations/agent-interactive-controls"
import {
  REVIEWED_MIGRATION_CODE_SHA256,
  assertReviewedManagedManifest,
} from "@/lib/preview-automation/managed-manifest"
import { partitionPendingMigrations } from "@/lib/migrations/runner"

const ROOT = process.cwd()
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf-8")
const runner = read("lib/migrations/runner.ts")
const schema = read("prisma/schema.prisma")
const sql = read(`prisma/migrations/${AGENT_INTERACTIVE_CONTROLS_MIGRATION}/migration.sql`)
const names = [...runner.matchAll(/name:\s*"(\d{3}_[a-z0-9_]+)"/g)].map((match) => match[1])

describe("121_agent_interactive_controls registration and DSQL-safe DDL", () => {
  it("registers 121_agent_interactive_controls after 120_agent_child_runs and passes reviewed manifest gate", () => {
    expect(AGENT_INTERACTIVE_CONTROLS_MIGRATION).toBe("121_agent_interactive_controls")
    expect(names.filter((n) => n === AGENT_INTERACTIVE_CONTROLS_MIGRATION)).toHaveLength(1)
    expect(names.indexOf(AGENT_INTERACTIVE_CONTROLS_MIGRATION)).toBeGreaterThan(names.indexOf("120_agent_child_runs"))
    expect(Object.keys(REVIEWED_MIGRATION_CODE_SHA256[AGENT_INTERACTIVE_CONTROLS_MIGRATION] ?? {})).toEqual([
      "lib/migrations/agent-interactive-controls.ts",
    ])
    const entries = partitionPendingMigrations("compass_pr_576_aaaaaaaaaaaa", new Set()).pending
    expect(() => assertReviewedManagedManifest(entries)).not.toThrow()
  })

  it("runs assertAgentInteractiveControlsMigration before writing the completion receipt", () => {
    const receipt = runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP')
    const hook = runner.indexOf(
      "if (migration.name === AGENT_INTERACTIVE_CONTROLS_MIGRATION) await assertAgentInteractiveControlsMigration",
    )
    expect(hook).toBeGreaterThan(-1)
    expect(hook).toBeLessThan(receipt)
  })

  it("uses UUID PKs, zero FKs/JSONB/TIMESTAMPTZ, ASYNC indexes, and matches schema.prisma", () => {
    const clean = sql
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n")
    expect(clean).not.toMatch(/REFERENCES|FOREIGN KEY|JSONB|SERIAL|TIMESTAMPTZ|CHECK/i)
    expect(clean.match(/CREATE INDEX ASYNC IF NOT EXISTS/gi)).toHaveLength(6)
    expect(schema).toContain('@@map("agent_inbox_items")')
    expect(schema).toContain('@@map("agent_scheduled_wakeups")')
  })
})

const inboxCols = [
  { column_name: "id", data_type: "uuid", is_nullable: "NO" },
  { column_name: "workspace_id", data_type: "uuid", is_nullable: "NO" },
  { column_name: "conversation_id", data_type: "uuid", is_nullable: "NO" },
  { column_name: "recipient_user_id", data_type: "uuid", is_nullable: "YES" },
  { column_name: "source_conversation_id", data_type: "uuid", is_nullable: "YES" },
  { column_name: "run_id", data_type: "uuid", is_nullable: "YES" },
  { column_name: "native_tool_use_id", data_type: "character varying", is_nullable: "YES" },
  { column_name: "kind", data_type: "character varying", is_nullable: "NO" },
  { column_name: "header", data_type: "character varying", is_nullable: "YES" },
  { column_name: "question", data_type: "text", is_nullable: "NO" },
  { column_name: "options_json", data_type: "text", is_nullable: "YES" },
  { column_name: "multi_select", data_type: "boolean", is_nullable: "NO" },
  { column_name: "allow_other", data_type: "boolean", is_nullable: "NO" },
  { column_name: "status", data_type: "character varying", is_nullable: "NO" },
  { column_name: "answer_text", data_type: "text", is_nullable: "YES" },
  { column_name: "resolved_by_user_id", data_type: "uuid", is_nullable: "YES" },
  { column_name: "created_at", data_type: "timestamp without time zone", is_nullable: "NO" },
  { column_name: "resolved_at", data_type: "timestamp without time zone", is_nullable: "YES" },
  { column_name: "updated_at", data_type: "timestamp without time zone", is_nullable: "NO" },
]

const wakeupCols = [
  { column_name: "id", data_type: "uuid", is_nullable: "NO" },
  { column_name: "workspace_id", data_type: "uuid", is_nullable: "NO" },
  { column_name: "conversation_id", data_type: "uuid", is_nullable: "NO" },
  { column_name: "user_id", data_type: "uuid", is_nullable: "NO" },
  { column_name: "agent_id", data_type: "uuid", is_nullable: "YES" },
  { column_name: "source_run_id", data_type: "uuid", is_nullable: "YES" },
  { column_name: "fire_at", data_type: "timestamp without time zone", is_nullable: "NO" },
  { column_name: "delay_seconds", data_type: "integer", is_nullable: "NO" },
  { column_name: "reason", data_type: "character varying", is_nullable: "YES" },
  { column_name: "prompt", data_type: "text", is_nullable: "NO" },
  { column_name: "status", data_type: "character varying", is_nullable: "NO" },
  { column_name: "fired_run_id", data_type: "uuid", is_nullable: "YES" },
  { column_name: "failure_reason", data_type: "character varying", is_nullable: "YES" },
  { column_name: "created_at", data_type: "timestamp without time zone", is_nullable: "NO" },
  { column_name: "fired_at", data_type: "timestamp without time zone", is_nullable: "YES" },
  { column_name: "canceled_at", data_type: "timestamp without time zone", is_nullable: "YES" },
  { column_name: "updated_at", data_type: "timestamp without time zone", is_nullable: "NO" },
]

function makeMockClient(overrides?: { dropCol?: string; invalidateIndex?: string }): PoolClient {
  return {
    query: async (_sqlText: string, params: unknown[]) => {
      const target = params[1] as string
      if (target === AGENT_INBOX_ITEMS_TABLE) {
        return { rows: inboxCols.filter((c) => c.column_name !== overrides?.dropCol) }
      }
      if (target === AGENT_SCHEDULED_WAKEUPS_TABLE) {
        return { rows: wakeupCols.filter((c) => c.column_name !== overrides?.dropCol) }
      }
      const idx = AGENT_INTERACTIVE_CONTROLS_INDEXES.find((i) => i.name === target)
      if (!idx) return { rows: [] }
      return {
        rows: [
          {
            valid: overrides?.invalidateIndex !== idx.name,
            ready: true,
            unique: idx.unique,
            table_name: idx.table,
            columns: idx.columns.split(","),
            predicate: null,
            expression: null,
          },
        ],
      }
    },
  } as unknown as PoolClient
}

describe("assertAgentInteractiveControlsMigration postconditions", () => {
  it("passes when both tables and all six indexes match", async () => {
    await expect(assertAgentInteractiveControlsMigration(makeMockClient(), "public")).resolves.toBeUndefined()
  })

  it("throws when a required column is missing", async () => {
    await expect(
      assertAgentInteractiveControlsMigration(makeMockClient({ dropCol: "options_json" }), "public"),
    ).rejects.toThrow(/options_json missing/)
  })

  it("throws when an async index is not yet valid", async () => {
    await expect(
      assertAgentInteractiveControlsMigration(
        makeMockClient({ invalidateIndex: "idx_agent_scheduled_wakeups_status_fire_at" }),
        "public",
      ),
    ).rejects.toThrow(/idx_agent_scheduled_wakeups_status_fire_at/)
  })
})
