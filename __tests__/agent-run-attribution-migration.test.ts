import { describe, expect, it, vi } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { PoolClient } from "pg"
import { assertAgentRunAttributionMigration } from "@/lib/migrations/agent-run-attribution"
import { assertReviewedManagedManifest, assertReviewedMigrationCode } from "@/lib/preview-automation/managed-manifest"
import { partitionPendingMigrations } from "@/lib/migrations/runner"

/**
 * Static guards for 100_agent_runs_agent_attribution. The DDL that reaches Aurora DSQL is the SQL
 * file, not schema.prisma, so the two are pinned to each other here.
 */
const ROOT = process.cwd()
const NAME = "100_agent_runs_agent_attribution"
const runner = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8")
const sqlPath = path.join(ROOT, "prisma/migrations", NAME, "migration.sql")
const sql = existsSync(sqlPath) ? readFileSync(sqlPath, "utf-8").split("\n").map((line) => line.replace(/--.*$/, "")).join("\n") : ""
const statements = sql.split(";").map((s) => s.trim()).filter(Boolean)
const agentRunModel = schema.match(/model AgentRun \{[\s\S]*?\n\}/)?.[0] ?? ""

describe(NAME, () => {
  it("is registered exactly once, directly after 099", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${NAME}"`, "g"))]).toHaveLength(1)
    expect(existsSync(sqlPath)).toBe(true)
    expect(runner.indexOf(`name: "${NAME}"`)).toBeGreaterThan(runner.indexOf('name: "099_agent_owner_user_nullable"'))
  })

  it("is two bare nullable columns, then two async indexes (one DDL per statement)", () => {
    expect(statements).toHaveLength(4)
    expect(statements[0]).toMatch(/^ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS agent_id UUID$/i)
    expect(statements[1]).toMatch(/^ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS invoked_by_user_id UUID$/i)
    expect(statements[2]).toMatch(/^CREATE INDEX ASYNC IF NOT EXISTS agent_runs_agent_id_created_at_idx ON agent_runs\(agent_id, created_at\)$/i)
    expect(statements[3]).toMatch(/^CREATE INDEX ASYNC IF NOT EXISTS agent_runs_invoked_by_user_id_idx ON agent_runs\(invoked_by_user_id\)$/i)
  })

  it("is idempotent and additive: no foreign keys, defaults, NOT NULL, backfill, partial indexes or deletes", () => {
    for (const statement of statements) expect(statement).toMatch(/IF NOT EXISTS/i)
    expect(sql).not.toMatch(/REFERENCES|CREATE TYPE|CREATE TRIGGER|\bWHERE\b|SERIAL|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bDEFAULT\b|\bNOT NULL\b|\bASC\b|\bDESC\b/i)
    expect(sql).not.toMatch(/DROP COLUMN|DROP TABLE|RENAME/i)
  })

  it("maps the same columns and indexes in schema.prisma, with no relation and no @updatedAt", () => {
    expect(agentRunModel).toMatch(/agentId\s+String\?\s+@map\("agent_id"\) @db\.Uuid/)
    expect(agentRunModel).toMatch(/invokedByUserId\s+String\?\s+@map\("invoked_by_user_id"\) @db\.Uuid/)
    expect(agentRunModel).toContain('@@index([agentId, createdAt], map: "agent_runs_agent_id_created_at_idx")')
    expect(agentRunModel).toContain('@@index([invokedByUserId], map: "agent_runs_invoked_by_user_id_idx")')
    expect(agentRunModel).not.toMatch(/@updatedAt/)
    // Only the existing conversation relation: the new columns are bare UUIDs.
    expect(agentRunModel.match(/@relation/g)).toHaveLength(1)
  })

  it("waits for its async indexes and verifies before the receipt", () => {
    expect(runner).toMatch(/const ASYNC_WAIT_MIGRATIONS = \[[^\]]*"100_agent_runs_agent_attribution"/)
    expect(runner).toMatch(/\["049_agent_identity"[^\]]*"100_agent_runs_agent_attribution"[^\]]*\]\.includes\(migration\.name\)/)
    const assertion = runner.indexOf('migration.name === "100_agent_runs_agent_attribution") await assertAgentRunAttributionMigration')
    expect(assertion).toBeGreaterThan(-1)
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'))
  })

  it("is in the reviewed managed manifest with matching SQL and postcondition digests", () => {
    const entries = partitionPendingMigrations("compass_pr_1_aaaaaaaaaaaa", new Set()).pending
    expect(entries.map((entry) => entry.name)).toContain(NAME)
    expect(() => assertReviewedManagedManifest(entries)).not.toThrow()
    expect(() => assertReviewedMigrationCode(NAME)).not.toThrow()
    // Editing the postcondition must re-review the migration.
    expect(() => assertReviewedMigrationCode(NAME, () => Buffer.from("tampered"))).toThrow(/digest changed/)
  })
})

const healthyColumns = [
  { column_name: "agent_id", is_nullable: "YES", data_type: "uuid" },
  { column_name: "invoked_by_user_id", is_nullable: "YES", data_type: "uuid" },
  { column_name: "user_id", is_nullable: "NO", data_type: "uuid" },
]
const healthyIndexes: Record<string, { valid: boolean; ready: boolean; unique: boolean; table_name: string; columns: string[]; predicate: string | null }> = {
  agent_runs_agent_id_created_at_idx: { valid: true, ready: true, unique: false, table_name: "agent_runs", columns: ["agent_id", "created_at"], predicate: null },
  agent_runs_invoked_by_user_id_idx: { valid: true, ready: true, unique: false, table_name: "agent_runs", columns: ["invoked_by_user_id"], predicate: null },
}

/** A client whose catalog answers the postcondition's queries. */
function client(options: { columns?: typeof healthyColumns; indexes?: Record<string, Partial<(typeof healthyIndexes)[string]> | null> } = {}): PoolClient {
  return {
    query: vi.fn(async (text: string, params: string[]) => {
      if (text.includes("information_schema.columns")) return { rows: options.columns ?? healthyColumns }
      const name = params[1]
      const override = options.indexes?.[name]
      if (override === null) return { rows: [] }
      return { rows: [{ ...healthyIndexes[name], ...override }] }
    }),
  } as unknown as PoolClient
}

describe(`${NAME} postcondition`, () => {
  it("passes when both columns are nullable uuid and both indexes are valid and ready", async () => {
    await expect(assertAgentRunAttributionMigration(client(), "s")).resolves.toBeUndefined()
  })

  it("fails when a column is missing, NOT NULL, or the wrong type", async () => {
    await expect(assertAgentRunAttributionMigration(client({ columns: healthyColumns.filter((c) => c.column_name !== "agent_id") }), "s")).rejects.toThrow(/agent_id/)
    await expect(assertAgentRunAttributionMigration(client({ columns: healthyColumns.map((c) => (c.column_name === "invoked_by_user_id" ? { ...c, is_nullable: "NO" } : c)) }), "s")).rejects.toThrow(/invoked_by_user_id/)
    await expect(assertAgentRunAttributionMigration(client({ columns: healthyColumns.map((c) => (c.column_name === "agent_id" ? { ...c, data_type: "text" } : c)) }), "s")).rejects.toThrow(/agent_id/)
  })

  it.each([
    ["missing", null],
    ["not yet valid", { valid: false }],
    ["not yet ready", { ready: false }],
    ["unique", { unique: true }],
    ["on the wrong columns", { columns: ["user_id"] }],
    ["on the wrong table", { table_name: "agents" }],
    ["partial", { predicate: "(status = 'ACTIVE')" }],
  ])("fails when either index is %s", async (_label, override) => {
    for (const name of Object.keys(healthyIndexes)) {
      await expect(assertAgentRunAttributionMigration(client({ indexes: { [name]: override } }), "s")).rejects.toThrow(new RegExp(name))
    }
  })
})
