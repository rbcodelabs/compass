import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import type { PoolClient } from "pg"
import {
  AGENT_CONVERSATION_SUPERVISION_TABLE,
  AGENT_ORCHESTRATORS_TABLE,
  AGENT_ORCHESTRATOR_SUPERVISION_INDEXES,
  AGENT_ORCHESTRATOR_SUPERVISION_MIGRATION,
  assertAgentOrchestratorSupervisionMigration,
} from "@/lib/migrations/agent-orchestrator-supervision"
import {
  REVIEWED_MIGRATION_CODE_SHA256,
  assertReviewedManagedManifest,
} from "@/lib/preview-automation/managed-manifest"
import { partitionPendingMigrations } from "@/lib/migrations/runner"

const ROOT = process.cwd()
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf-8")
const runner = read("lib/migrations/runner.ts")
const schema = read("prisma/schema.prisma")
const sql = read(`prisma/migrations/${AGENT_ORCHESTRATOR_SUPERVISION_MIGRATION}/migration.sql`)
const names = [...runner.matchAll(/name:\s*"(\d{3}_[a-z0-9_]+)"/g)].map((match) => match[1])

describe("122_agent_orchestrator_supervision registration and DSQL-safe DDL", () => {
  it("registers 122_agent_orchestrator_supervision after 121_agent_interactive_controls and passes reviewed manifest gate", () => {
    expect(AGENT_ORCHESTRATOR_SUPERVISION_MIGRATION).toBe("122_agent_orchestrator_supervision")
    expect(names.filter((n) => n === AGENT_ORCHESTRATOR_SUPERVISION_MIGRATION)).toHaveLength(1)
    expect(names.indexOf(AGENT_ORCHESTRATOR_SUPERVISION_MIGRATION)).toBeGreaterThan(
      names.indexOf("121_agent_interactive_controls"),
    )
    expect(Object.keys(REVIEWED_MIGRATION_CODE_SHA256[AGENT_ORCHESTRATOR_SUPERVISION_MIGRATION] ?? {})).toEqual([
      "lib/migrations/agent-orchestrator-supervision.ts",
    ])
    const entries = partitionPendingMigrations("compass_pr_579_aaaaaaaaaaaa", new Set()).pending
    expect(() => assertReviewedManagedManifest(entries)).not.toThrow()
  })

  it("runs assertAgentOrchestratorSupervisionMigration before writing the completion receipt", () => {
    const receipt = runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP')
    const hook = runner.indexOf(
      "if (migration.name === AGENT_ORCHESTRATOR_SUPERVISION_MIGRATION) await assertAgentOrchestratorSupervisionMigration",
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
    expect(clean.match(/CREATE (?:UNIQUE )?INDEX ASYNC IF NOT EXISTS/gi)).toHaveLength(5)
    expect(schema).toContain('@@map("agent_orchestrators")')
    expect(schema).toContain('@@map("agent_conversation_supervision")')
  })
})

const orchestratorCols = [
  { column_name: "id", data_type: "uuid", is_nullable: "NO" },
  { column_name: "workspace_id", data_type: "uuid", is_nullable: "NO" },
  { column_name: "user_id", data_type: "uuid", is_nullable: "NO" },
  { column_name: "scope_type", data_type: "character varying", is_nullable: "NO" },
  { column_name: "scope_key", data_type: "character varying", is_nullable: "NO" },
  { column_name: "conversation_id", data_type: "uuid", is_nullable: "YES" },
  { column_name: "agent_id", data_type: "uuid", is_nullable: "YES" },
  { column_name: "enabled", data_type: "boolean", is_nullable: "NO" },
  { column_name: "wake_on_activity", data_type: "boolean", is_nullable: "NO" },
  { column_name: "heartbeat_enabled", data_type: "boolean", is_nullable: "NO" },
  { column_name: "heartbeat_minutes", data_type: "integer", is_nullable: "NO" },
  { column_name: "escalations_enabled", data_type: "boolean", is_nullable: "NO" },
  { column_name: "last_heartbeat_at", data_type: "timestamp without time zone", is_nullable: "YES" },
  { column_name: "last_escalation_state_json", data_type: "text", is_nullable: "NO" },
  { column_name: "created_at", data_type: "timestamp without time zone", is_nullable: "NO" },
  { column_name: "updated_at", data_type: "timestamp without time zone", is_nullable: "NO" },
]

const supervisionCols = [
  { column_name: "id", data_type: "uuid", is_nullable: "NO" },
  { column_name: "workspace_id", data_type: "uuid", is_nullable: "NO" },
  { column_name: "conversation_id", data_type: "uuid", is_nullable: "NO" },
  { column_name: "supervisor_user_id", data_type: "uuid", is_nullable: "NO" },
  { column_name: "manager_notes", data_type: "text", is_nullable: "NO" },
  { column_name: "manager_notes_updated_at", data_type: "timestamp without time zone", is_nullable: "YES" },
  { column_name: "manager_source_orchestrator_id", data_type: "uuid", is_nullable: "YES" },
  { column_name: "proposed_reply_text", data_type: "text", is_nullable: "YES" },
  { column_name: "proposed_reply_generated_at", data_type: "timestamp without time zone", is_nullable: "YES" },
  { column_name: "proposed_reply_author_orchestrator_id", data_type: "uuid", is_nullable: "YES" },
  { column_name: "created_at", data_type: "timestamp without time zone", is_nullable: "NO" },
  { column_name: "updated_at", data_type: "timestamp without time zone", is_nullable: "NO" },
]

function makeMockClient(overrides?: { dropCol?: string; invalidateIndex?: string }): PoolClient {
  return {
    query: async (_sqlText: string, params: unknown[]) => {
      const target = params[1] as string
      if (target === AGENT_ORCHESTRATORS_TABLE) {
        return { rows: orchestratorCols.filter((c) => c.column_name !== overrides?.dropCol) }
      }
      if (target === AGENT_CONVERSATION_SUPERVISION_TABLE) {
        return { rows: supervisionCols.filter((c) => c.column_name !== overrides?.dropCol) }
      }
      const idx = AGENT_ORCHESTRATOR_SUPERVISION_INDEXES.find((i) => i.name === target)
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

describe("assertAgentOrchestratorSupervisionMigration postconditions", () => {
  it("passes when both tables and all five indexes match", async () => {
    await expect(assertAgentOrchestratorSupervisionMigration(makeMockClient(), "public")).resolves.toBeUndefined()
  })

  it("throws when a required column is missing", async () => {
    await expect(
      assertAgentOrchestratorSupervisionMigration(
        makeMockClient({ dropCol: "proposed_reply_text" }),
        "public",
      ),
    ).rejects.toThrow(/proposed_reply_text missing/)
  })

  it("throws when an async index is not yet valid", async () => {
    await expect(
      assertAgentOrchestratorSupervisionMigration(
        makeMockClient({ invalidateIndex: "agent_orchestrators_user_ws_scope_key" }),
        "public",
      ),
    ).rejects.toThrow(/agent_orchestrators_user_ws_scope_key/)
  })
})
