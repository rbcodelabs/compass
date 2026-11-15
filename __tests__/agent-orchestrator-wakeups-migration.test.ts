import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import type { PoolClient } from "pg"
import {
  AGENT_ORCHESTRATOR_WAKEUPS_INDEXES,
  AGENT_ORCHESTRATOR_WAKEUPS_MIGRATION,
  AGENT_ORCHESTRATOR_WAKEUPS_TABLE,
  assertAgentOrchestratorWakeupsMigration,
} from "@/lib/migrations/agent-orchestrator-wakeups"
import {
  REVIEWED_MIGRATION_CODE_SHA256,
  assertReviewedManagedManifest,
} from "@/lib/preview-automation/managed-manifest"
import { partitionPendingMigrations } from "@/lib/migrations/runner"

const ROOT = process.cwd()
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf-8")
const runner = read("lib/migrations/runner.ts")
const schema = read("prisma/schema.prisma")
const sql = read(`prisma/migrations/${AGENT_ORCHESTRATOR_WAKEUPS_MIGRATION}/migration.sql`)
const names = [...runner.matchAll(/name:\s*"(\d{3}_[a-z0-9_]+)"/g)].map((match) => match[1])

describe("123_agent_orchestrator_wakeups registration and DSQL-safe DDL", () => {
  it("registers 123_agent_orchestrator_wakeups after 122_agent_orchestrator_supervision and passes reviewed manifest gate", () => {
    expect(AGENT_ORCHESTRATOR_WAKEUPS_MIGRATION).toBe("123_agent_orchestrator_wakeups")
    expect(names.filter((n) => n === AGENT_ORCHESTRATOR_WAKEUPS_MIGRATION)).toHaveLength(1)
    expect(names.indexOf(AGENT_ORCHESTRATOR_WAKEUPS_MIGRATION)).toBeGreaterThan(
      names.indexOf("122_agent_orchestrator_supervision"),
    )
    expect(Object.keys(REVIEWED_MIGRATION_CODE_SHA256[AGENT_ORCHESTRATOR_WAKEUPS_MIGRATION] ?? {})).toEqual([
      "lib/migrations/agent-orchestrator-wakeups.ts",
    ])
    const entries = partitionPendingMigrations("compass_pr_580_aaaaaaaaaaaa", new Set()).pending
    expect(() => assertReviewedManagedManifest(entries)).not.toThrow()
  })

  it("runs assertAgentOrchestratorWakeupsMigration before writing the completion receipt", () => {
    const receipt = runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP')
    const hook = runner.indexOf(
      "if (migration.name === AGENT_ORCHESTRATOR_WAKEUPS_MIGRATION) await assertAgentOrchestratorWakeupsMigration",
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
    expect(clean.match(/CREATE (?:UNIQUE )?INDEX ASYNC IF NOT EXISTS/gi)).toHaveLength(4)
    expect(schema).toContain('@@map("agent_orchestrator_wakeups")')
  })
})

const wakeupCols = [
  { column_name: "id", data_type: "uuid", is_nullable: "NO" },
  { column_name: "orchestrator_id", data_type: "uuid", is_nullable: "NO" },
  { column_name: "workspace_id", data_type: "uuid", is_nullable: "NO" },
  { column_name: "target_conversation_id", data_type: "uuid", is_nullable: "NO" },
  { column_name: "event_status", data_type: "character varying", is_nullable: "NO" },
  { column_name: "target_updated_at_iso", data_type: "character varying", is_nullable: "NO" },
  { column_name: "quiet_until", data_type: "timestamp without time zone", is_nullable: "NO" },
  { column_name: "flush_after", data_type: "timestamp without time zone", is_nullable: "YES" },
  { column_name: "generation", data_type: "integer", is_nullable: "NO" },
  { column_name: "busy_retries", data_type: "integer", is_nullable: "NO" },
  { column_name: "state", data_type: "character varying", is_nullable: "NO" },
  { column_name: "dispatched_run_id", data_type: "uuid", is_nullable: "YES" },
  { column_name: "created_at", data_type: "timestamp without time zone", is_nullable: "NO" },
  { column_name: "updated_at", data_type: "timestamp without time zone", is_nullable: "NO" },
]

function makeMockClient(overrides?: { dropCol?: string; invalidateIndex?: string }): PoolClient {
  return {
    query: async (_sqlText: string, params: unknown[]) => {
      const target = params[1] as string
      if (target === AGENT_ORCHESTRATOR_WAKEUPS_TABLE) {
        return { rows: wakeupCols.filter((c) => c.column_name !== overrides?.dropCol) }
      }
      const idx = AGENT_ORCHESTRATOR_WAKEUPS_INDEXES.find((i) => i.name === target)
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

describe("assertAgentOrchestratorWakeupsMigration postconditions", () => {
  it("passes when the table and all four indexes match", async () => {
    await expect(assertAgentOrchestratorWakeupsMigration(makeMockClient(), "public")).resolves.toBeUndefined()
  })

  it("throws when a required column is missing", async () => {
    await expect(
      assertAgentOrchestratorWakeupsMigration(
        makeMockClient({ dropCol: "quiet_until" }),
        "public",
      ),
    ).rejects.toThrow(/quiet_until missing/)
  })

  it("throws when an async index is not yet valid", async () => {
    await expect(
      assertAgentOrchestratorWakeupsMigration(
        makeMockClient({ invalidateIndex: "agent_orchestrator_wakeups_orch_target_key" }),
        "public",
      ),
    ).rejects.toThrow(/agent_orchestrator_wakeups_orch_target_key/)
  })
})
