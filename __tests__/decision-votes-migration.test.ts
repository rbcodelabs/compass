import { describe, expect, it, vi } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { assertDecisionVotesMigration } from "@/lib/migrations/decision-votes"

/** Static guards for 127_decision_votes: the SQL file is what reaches Aurora DSQL / Postgres. */
const ROOT = process.cwd()
const NAME = "127_decision_votes"
const runner = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
const sqlPath = path.join(ROOT, "prisma/migrations", NAME, "migration.sql")
const sql = existsSync(sqlPath) ? readFileSync(sqlPath, "utf-8").split("\n").map((line) => line.replace(/--.*$/, "")).join("\n") : ""
const statements = sql.split(";").map((s) => s.trim()).filter(Boolean)

describe(NAME, () => {
  it("is registered exactly once, after 110", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${NAME}"`, "g"))]).toHaveLength(1)
    expect(existsSync(sqlPath)).toBe(true)
    expect(runner.indexOf(`name: "${NAME}"`)).toBeGreaterThan(runner.indexOf('name: "110_agent_sandbox_class"'))
  })

  it("is one idempotent table plus one async unique index, with no foreign key, trigger or existing-table change (DSQL rules)", () => {
    expect(statements).toHaveLength(2)
    expect(statements[0]).toMatch(/^CREATE TABLE IF NOT EXISTS decision_votes \(/i)
    expect(statements[1]).toMatch(/^CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_decision_votes_voter ON decision_votes\(request_id, revision_id, question_index, voter_user_id\)$/i)
    expect(sql).not.toMatch(/REFERENCES|CREATE TYPE|CREATE TRIGGER|ALTER TABLE|\bWHERE\b|DROP|\bASC\b|\bDESC\b|SERIAL/i)
  })


  it("waits for the async index build like the other index migrations, so the postcondition cannot fail on the first DSQL run", () => {
    expect(runner).toMatch(/const ASYNC_WAIT_MIGRATIONS = \[[^\]]*"127_decision_votes"/)
    expect(runner).toMatch(/\["049_agent_identity"[^\]]*"127_decision_votes"[^\]]*\]\.includes\(migration\.name\)/)
  })

  it("verifies before the receipt", () => {
    const assertion = runner.indexOf("migration.name === DECISION_VOTES_MIGRATION) await assertDecisionVotesMigration")
    expect(assertion).toBeGreaterThan(-1)
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'))
  })

  describe("postcondition", () => {
    const columns = ["id", "workspace_id", "request_id", "revision_id", "question_index", "chosen_option", "voter_user_id", "created_at", "updated_at"].map((column_name) => ({ column_name, is_nullable: "NO", is_generated: "NEVER", data_type: column_name === "chosen_option" ? "character varying" : column_name === "question_index" ? "integer" : column_name.endsWith("_at") ? "timestamp without time zone" : "uuid", character_maximum_length: column_name === "chosen_option" ? 120 : null }))
    const index = (overrides: Record<string, unknown> = {}) => ({
      valid: true, ready: true, unique: true, table_name: "decision_votes", columns: ["request_id", "revision_id", "question_index", "voter_user_id"], predicate: null, expression: null, ...overrides,
    })
    const client = (cols: unknown[], indexes: unknown[]) => {
      const query = vi.fn().mockResolvedValueOnce({ rows: cols })
      query.mockResolvedValueOnce({ rows: indexes })
      return { query } as never
    }

    it("passes for the shape the migration creates", async () => {
      await expect(assertDecisionVotesMigration(client(columns, [index()]), "compass")).resolves.toBeUndefined()
    })

    it("fails closed on a missing column", async () => {
      await expect(assertDecisionVotesMigration(client(columns.filter((c) => c.column_name !== "voter_user_id"), [index()]), "compass")).rejects.toThrow(/voter_user_id/)
    })

    it("fails closed on an index that is missing, still building, or not unique", async () => {
      await expect(assertDecisionVotesMigration(client(columns, []), "compass")).rejects.toThrow(/idx_decision_votes_voter/)
      await expect(assertDecisionVotesMigration(client(columns, [index({ valid: false })]), "compass")).rejects.toThrow(/not ready/)
      await expect(assertDecisionVotesMigration(client(columns, [index({ unique: false })]), "compass")).rejects.toThrow(/idx_decision_votes_voter/)
    })
  })
})
