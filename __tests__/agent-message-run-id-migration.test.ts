import { describe, expect, it, vi } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { assertAgentMessageRunIdMigration } from "@/lib/migrations/agent-message-run-id"

/** Static guards and the postcondition for 129_agent_message_run_id (the SQL file is what reaches Aurora DSQL / Postgres). */
const ROOT = process.cwd()
const NAME = "129_agent_message_run_id"
const runner = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
const sqlPath = path.join(ROOT, "prisma/migrations", NAME, "migration.sql")
const sql = existsSync(sqlPath) ? readFileSync(sqlPath, "utf-8").split("\n").map((line) => line.replace(/--.*$/, "")).join("\n") : ""
const statements = sql.split(";").map((s) => s.trim()).filter(Boolean)

describe(NAME, () => {
  it("is one nullable column and one async index, with no foreign key, default or backfill (DSQL rules)", () => {
    expect(statements).toHaveLength(2)
    expect(statements[0]).toMatch(/^ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS run_id UUID$/i)
    expect(statements[1]).toMatch(/^CREATE INDEX ASYNC IF NOT EXISTS idx_agent_messages_run ON agent_messages\(run_id\)$/i)
    expect(sql).not.toMatch(/REFERENCES|DEFAULT|\bUPDATE\b|\bWHERE\b|DROP|\bASC\b|\bDESC\b/i)
  })

  it("is registered exactly once", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${NAME}"`, "g"))]).toHaveLength(1)
  })

  it("waits for the async index build, and tolerates the no-job IF NOT EXISTS replay, like every other agent index migration", () => {
    expect(runner).toMatch(new RegExp(`const ASYNC_WAIT_MIGRATIONS = \\[[^\\]]*"${NAME}"`))
    expect(runner).toMatch(new RegExp(`\\["049_agent_identity"[^\\]]*"${NAME}"[^\\]]*\\]\\.includes\\(migration\\.name\\)`))
  })

  it("verifies the catalog before the receipt", () => {
    const assertion = runner.indexOf("migration.name === AGENT_MESSAGE_RUN_ID_MIGRATION) await assertAgentMessageRunIdMigration")
    expect(assertion).toBeGreaterThan(-1)
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'))
  })

  describe("postcondition", () => {
    const column = (overrides: Record<string, unknown> = {}) => ({ data_type: "uuid", is_nullable: "YES", column_default: null, is_generated: "NEVER", ...overrides })
    const index = (overrides: Record<string, unknown> = {}) => ({ valid: true, ready: true, unique: false, table_name: "agent_messages", column_count: 1, columns: ["run_id"], predicate: null, expression: null, ...overrides })
    const client = (cols: unknown[], indexRows: unknown[]) => ({ query: vi.fn().mockResolvedValueOnce({ rows: cols }).mockResolvedValueOnce({ rows: indexRows }) }) as never

    it("passes for the shape the migration creates", async () => {
      await expect(assertAgentMessageRunIdMigration(client([column()], [index()]), "compass")).resolves.toBeUndefined()
    })

    it("fails closed when the column is missing, not a uuid, not nullable, or has a default", async () => {
      await expect(assertAgentMessageRunIdMigration(client([], [index()]), "compass")).rejects.toThrow(/agent_messages\.run_id/)
      await expect(assertAgentMessageRunIdMigration(client([column({ data_type: "text" })], [index()]), "compass")).rejects.toThrow(/agent_messages\.run_id/)
      await expect(assertAgentMessageRunIdMigration(client([column({ is_nullable: "NO" })], [index()]), "compass")).rejects.toThrow(/agent_messages\.run_id/)
      await expect(assertAgentMessageRunIdMigration(client([column({ column_default: "gen_random_uuid()" })], [index()]), "compass")).rejects.toThrow(/agent_messages\.run_id/)
      await expect(assertAgentMessageRunIdMigration(client([column({ is_generated: "ALWAYS" })], [index()]), "compass")).rejects.toThrow(/writable nullable uuid/)
    })

    it("fails closed on an index that is missing, still building, or a same-named object with the wrong definition", async () => {
      await expect(assertAgentMessageRunIdMigration(client([column()], []), "compass")).rejects.toThrow(/idx_agent_messages_run/)
      await expect(assertAgentMessageRunIdMigration(client([column()], [index({ valid: false })]), "compass")).rejects.toThrow(/not ready/)
      await expect(assertAgentMessageRunIdMigration(client([column()], [index({ ready: false })]), "compass")).rejects.toThrow(/not ready/)
      await expect(assertAgentMessageRunIdMigration(client([column()], [index({ unique: true })]), "compass")).rejects.toThrow(/drifted/)
      await expect(assertAgentMessageRunIdMigration(client([column()], [index({ columns: ["conversation_id"] })]), "compass")).rejects.toThrow(/drifted/)
      await expect(assertAgentMessageRunIdMigration(client([column()], [index({ column_count: 2 })]), "compass")).rejects.toThrow(/drifted/)
      await expect(assertAgentMessageRunIdMigration(client([column()], [index({ table_name: "agent_runs" })]), "compass")).rejects.toThrow(/drifted/)
      await expect(assertAgentMessageRunIdMigration(client([column()], [index({ predicate: "(run_id IS NOT NULL)" })]), "compass")).rejects.toThrow(/drifted/)
    })
  })
})
