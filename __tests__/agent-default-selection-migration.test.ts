import { describe, expect, it, vi } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { PoolClient } from "pg"
import { assertAgentDefaultSelectionMigration } from "@/lib/migrations/agent-default-selection"
import { assertReviewedManagedManifest, assertReviewedMigrationCode } from "@/lib/preview-automation/managed-manifest"
import { partitionPendingMigrations } from "@/lib/migrations/runner"

/** Static guards for 101_agent_default_selection: the DDL that reaches Aurora DSQL is the SQL file, not schema.prisma. */
const ROOT = process.cwd()
const NAME = "101_agent_default_selection"
const runner = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8")
const sqlPath = path.join(ROOT, "prisma/migrations", NAME, "migration.sql")
const sql = existsSync(sqlPath) ? readFileSync(sqlPath, "utf-8").split("\n").map((line) => line.replace(/--.*$/, "")).join("\n") : ""
const statements = sql.split(";").map((s) => s.trim()).filter(Boolean)
const workspaceModel = schema.match(/model WorkspaceDefaultAgent \{[\s\S]*?\n\}/)?.[0] ?? ""
const userModel = schema.match(/model UserDefaultAgent \{[\s\S]*?\n\}/)?.[0] ?? ""

describe(NAME, () => {
  it("is registered exactly once, directly after 100", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${NAME}"`, "g"))]).toHaveLength(1)
    expect(existsSync(sqlPath)).toBe(true)
    expect(runner.indexOf(`name: "${NAME}"`)).toBeGreaterThan(runner.indexOf('name: "100_agent_runs_agent_attribution"'))
  })

  it("is two tables and two unique async indexes, one DDL per statement, no FK and no partial index", () => {
    expect(statements).toHaveLength(4)
    expect(statements[0]).toMatch(/^CREATE TABLE IF NOT EXISTS workspace_default_agents \(/i)
    expect(statements[1]).toMatch(/^CREATE UNIQUE INDEX ASYNC IF NOT EXISTS workspace_default_agents_workspace_id_key ON workspace_default_agents\(workspace_id\)$/i)
    expect(statements[2]).toMatch(/^CREATE TABLE IF NOT EXISTS user_default_agents \(/i)
    expect(statements[3]).toMatch(/^CREATE UNIQUE INDEX ASYNC IF NOT EXISTS user_default_agents_user_id_workspace_id_key ON user_default_agents\(user_id, workspace_id\)$/i)
    expect(sql).not.toMatch(/REFERENCES|FOREIGN KEY|\bWHERE\b|\bJSON\b|SERIAL/i)
    expect(sql).not.toMatch(/DROP |RENAME/i)
  })

  it("maps the same tables and unique indexes in schema.prisma, with no relation and no @updatedAt", () => {
    expect(workspaceModel).toContain('@@map("workspace_default_agents")')
    expect(workspaceModel).toContain('@@unique([workspaceId], map: "workspace_default_agents_workspace_id_key")')
    expect(userModel).toContain('@@map("user_default_agents")')
    expect(userModel).toContain('@@unique([userId, workspaceId], map: "user_default_agents_user_id_workspace_id_key")')
    for (const model of [workspaceModel, userModel]) {
      expect(model).not.toMatch(/@updatedAt|@relation/)
      expect(model).toMatch(/agentId\s+String\s+@map\("agent_id"\) @db\.Uuid/)
    }
  })

  it("waits for its async indexes and verifies before the receipt", () => {
    expect(runner).toMatch(/const ASYNC_WAIT_MIGRATIONS = \[[^\]]*"101_agent_default_selection"/)
    expect(runner).toMatch(/\["049_agent_identity"[^\]]*"101_agent_default_selection"[^\]]*\]\.includes\(migration\.name\)/)
    const assertion = runner.indexOf('migration.name === "101_agent_default_selection") await assertAgentDefaultSelectionMigration')
    expect(assertion).toBeGreaterThan(-1)
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'))
  })

  it("is in the reviewed managed manifest with matching SQL and postcondition digests", () => {
    const entries = partitionPendingMigrations("compass_pr_1_aaaaaaaaaaaa", new Set()).pending
    expect(entries.map((entry) => entry.name)).toContain(NAME)
    expect(() => assertReviewedManagedManifest(entries)).not.toThrow()
    expect(() => assertReviewedMigrationCode(NAME)).not.toThrow()
    expect(() => assertReviewedMigrationCode(NAME, () => Buffer.from("tampered"))).toThrow(/digest changed/)
  })
})

type Col = { column_name: string; is_nullable: string; data_type: string }
const ts = "timestamp without time zone"
const healthyColumns: Record<string, Col[]> = {
  workspace_default_agents: [
    { column_name: "id", is_nullable: "NO", data_type: "uuid" },
    { column_name: "workspace_id", is_nullable: "NO", data_type: "uuid" },
    { column_name: "agent_id", is_nullable: "NO", data_type: "uuid" },
    { column_name: "set_by_user_id", is_nullable: "YES", data_type: "uuid" },
    { column_name: "created_at", is_nullable: "NO", data_type: ts },
    { column_name: "updated_at", is_nullable: "NO", data_type: ts },
  ],
  user_default_agents: [
    { column_name: "id", is_nullable: "NO", data_type: "uuid" },
    { column_name: "user_id", is_nullable: "NO", data_type: "uuid" },
    { column_name: "workspace_id", is_nullable: "NO", data_type: "uuid" },
    { column_name: "agent_id", is_nullable: "NO", data_type: "uuid" },
    { column_name: "created_at", is_nullable: "NO", data_type: ts },
    { column_name: "updated_at", is_nullable: "NO", data_type: ts },
  ],
}
type Idx = { valid: boolean; ready: boolean; unique: boolean; table_name: string; columns: string[]; predicate: string | null }
const healthyIndexes: Record<string, Idx> = {
  workspace_default_agents_workspace_id_key: { valid: true, ready: true, unique: true, table_name: "workspace_default_agents", columns: ["workspace_id"], predicate: null },
  user_default_agents_user_id_workspace_id_key: { valid: true, ready: true, unique: true, table_name: "user_default_agents", columns: ["user_id", "workspace_id"], predicate: null },
}

function client(options: { columns?: Record<string, Col[]>; indexes?: Record<string, Partial<Idx> | null> } = {}): PoolClient {
  return {
    query: vi.fn(async (text: string, params: string[]) => {
      if (text.includes("information_schema.columns")) return { rows: (options.columns ?? healthyColumns)[params[1]] ?? [] }
      const override = options.indexes?.[params[1]]
      if (override === null) return { rows: [] }
      return { rows: [{ ...healthyIndexes[params[1]], ...override }] }
    }),
  } as unknown as PoolClient
}

describe(`${NAME} postcondition`, () => {
  it("passes when both tables and both unique indexes are healthy", async () => {
    await expect(assertAgentDefaultSelectionMigration(client(), "s")).resolves.toBeUndefined()
  })

  it("fails when a column is missing, has the wrong nullability, or the wrong type", async () => {
    const without = { ...healthyColumns, user_default_agents: healthyColumns.user_default_agents.filter((c) => c.column_name !== "agent_id") }
    await expect(assertAgentDefaultSelectionMigration(client({ columns: without }), "s")).rejects.toThrow(/user_default_agents\.agent_id/)
    const nullable = { ...healthyColumns, workspace_default_agents: healthyColumns.workspace_default_agents.map((c) => (c.column_name === "workspace_id" ? { ...c, is_nullable: "YES" } : c)) }
    await expect(assertAgentDefaultSelectionMigration(client({ columns: nullable }), "s")).rejects.toThrow(/workspace_default_agents\.workspace_id/)
    const wrongType = { ...healthyColumns, workspace_default_agents: healthyColumns.workspace_default_agents.map((c) => (c.column_name === "agent_id" ? { ...c, data_type: "text" } : c)) }
    await expect(assertAgentDefaultSelectionMigration(client({ columns: wrongType }), "s")).rejects.toThrow(/workspace_default_agents\.agent_id/)
  })

  it.each([
    ["missing", null],
    ["not yet valid", { valid: false }],
    ["not yet ready", { ready: false }],
    ["not unique", { unique: false }],
    ["on the wrong columns", { columns: ["agent_id"] }],
    ["on the wrong table", { table_name: "agents" }],
    ["partial", { predicate: "(agent_id IS NOT NULL)" }],
  ])("fails when either unique index is %s", async (_label, override) => {
    for (const name of Object.keys(healthyIndexes)) {
      await expect(assertAgentDefaultSelectionMigration(client({ indexes: { [name]: override } }), "s")).rejects.toThrow(new RegExp(name))
    }
  })
})
