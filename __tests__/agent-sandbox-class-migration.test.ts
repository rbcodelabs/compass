import { describe, expect, it, vi } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { assertAgentSandboxClassMigration } from "@/lib/migrations/agent-sandbox-class"

/** Static guards for 110_agent_sandbox_class: the SQL file is what reaches Aurora DSQL / Postgres. */
const ROOT = process.cwd()
const NAME = "110_agent_sandbox_class"
const runner = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8")
const sqlPath = path.join(ROOT, "prisma/migrations", NAME, "migration.sql")
const sql = existsSync(sqlPath) ? readFileSync(sqlPath, "utf-8").split("\n").map((line) => line.replace(/--.*$/, "")).join("\n") : ""
const statements = sql.split(";").map((s) => s.trim()).filter(Boolean)

describe(NAME, () => {
  it("is registered exactly once, after 109", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${NAME}"`, "g"))]).toHaveLength(1)
    expect(existsSync(sqlPath)).toBe(true)
    expect(runner.indexOf(`name: "${NAME}"`)).toBeGreaterThan(runner.indexOf('name: "109_agent_conversation_reviews"'))
  })

  it("is two idempotent nullable columns, one table and one async unique index, with no foreign key, trigger, default or backfill (DSQL rules)", () => {
    expect(statements).toHaveLength(4)
    expect(statements[0]).toMatch(/^ALTER TABLE agents ADD COLUMN IF NOT EXISTS sandbox_class VARCHAR\(20\)$/i)
    expect(statements[1]).toMatch(/^ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS agent_developer_sandbox_enabled BOOLEAN$/i)
    expect(statements[2]).toMatch(/^CREATE TABLE IF NOT EXISTS agent_runtime_snapshots \(/i)
    expect(statements[3]).toMatch(/^CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_agent_runtime_snapshots_class ON agent_runtime_snapshots\(sandbox_class\)$/i)
    expect(sql).not.toMatch(/REFERENCES|CREATE TYPE|CREATE TRIGGER|\bUPDATE\b|\bWHERE\b|DROP|\bASC\b|\bDESC\b|SERIAL|NOT NULL DEFAULT (true|false)/i)
  })

  it("is mirrored in schema.prisma on all three models, with no @updatedAt", () => {
    expect(schema).toContain('@map("agent_developer_sandbox_enabled")')
    expect(schema).toContain('sandboxClass String? @map("sandbox_class") @db.VarChar(20)')
    const model = schema.slice(schema.indexOf("model AgentRuntimeSnapshot {"))
    const body = model.slice(0, model.indexOf("\n}\n"))
    expect(body).toContain('@@map("agent_runtime_snapshots")')
    expect(body).toContain('@@unique([sandboxClass], map: "idx_agent_runtime_snapshots_class")')
    expect(body).toContain('@map("base_snapshot_id")')
    expect(body).not.toContain("@updatedAt")
  })

  it("waits for the async index build like 109 does", () => {
    expect(runner).toMatch(/const ASYNC_WAIT_MIGRATIONS = \[[^\]]*"110_agent_sandbox_class"/)
    expect(runner).toMatch(/\["049_agent_identity"[^\]]*"110_agent_sandbox_class"[^\]]*\]\.includes\(migration\.name\)/)
  })

  it("verifies before the receipt", () => {
    const assertion = runner.indexOf("migration.name === AGENT_SANDBOX_CLASS_MIGRATION) await assertAgentSandboxClassMigration")
    expect(assertion).toBeGreaterThan(-1)
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'))
  })

  describe("postcondition", () => {
    const columns = [
      ["agents", "sandbox_class", "YES"], ["workspaces", "agent_developer_sandbox_enabled", "YES"],
      ["agent_runtime_snapshots", "id", "NO"], ["agent_runtime_snapshots", "sandbox_class", "NO"],
      ["agent_runtime_snapshots", "snapshot_id", "YES"], ["agent_runtime_snapshots", "deps_fingerprint", "YES"],
      ["agent_runtime_snapshots", "base_snapshot_id", "YES"], ["agent_runtime_snapshots", "snapshot_built_at", "YES"],
      ["agent_runtime_snapshots", "created_at", "NO"], ["agent_runtime_snapshots", "updated_at", "NO"],
    ].map(([table_name, column_name, is_nullable]) => ({ table_name, column_name, is_nullable }))
    const index = (overrides: Record<string, unknown> = {}) => ({ valid: true, ready: true, unique: true, table_name: "agent_runtime_snapshots", columns: ["sandbox_class"], predicate: null, expression: null, ...overrides })
    const client = (cols: unknown[], indexRows: unknown[]) => ({ query: vi.fn().mockResolvedValueOnce({ rows: cols }).mockResolvedValueOnce({ rows: indexRows }) }) as never

    it("passes for the shape the migration creates", async () => {
      await expect(assertAgentSandboxClassMigration(client(columns, [index()]), "compass")).resolves.toBeUndefined()
    })

    it("fails closed on a missing column", async () => {
      await expect(assertAgentSandboxClassMigration(client(columns.filter((c) => c.column_name !== "sandbox_class" || c.table_name !== "agents"), [index()]), "compass")).rejects.toThrow(/agents\.sandbox_class/)
    })

    it("fails closed on an index that is missing, still building, or not unique", async () => {
      await expect(assertAgentSandboxClassMigration(client(columns, []), "compass")).rejects.toThrow(/idx_agent_runtime_snapshots_class/)
      await expect(assertAgentSandboxClassMigration(client(columns, [index({ valid: false })]), "compass")).rejects.toThrow(/not ready/)
      await expect(assertAgentSandboxClassMigration(client(columns, [index({ unique: false })]), "compass")).rejects.toThrow(/drifted/)
    })
  })
})
