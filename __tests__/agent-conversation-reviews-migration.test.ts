import { describe, expect, it, vi } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { assertAgentConversationReviewsMigration } from "@/lib/migrations/agent-conversation-reviews"

/** Static guards for 109_agent_conversation_reviews: the SQL file is what reaches Aurora DSQL / Postgres. */
const ROOT = process.cwd()
const NAME = "109_agent_conversation_reviews"
const runner = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8")
const sqlPath = path.join(ROOT, "prisma/migrations", NAME, "migration.sql")
const sql = existsSync(sqlPath) ? readFileSync(sqlPath, "utf-8").split("\n").map((line) => line.replace(/--.*$/, "")).join("\n") : ""
const statements = sql.split(";").map((s) => s.trim()).filter(Boolean)

describe(NAME, () => {
  it("is registered exactly once, after 108", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${NAME}"`, "g"))]).toHaveLength(1)
    expect(existsSync(sqlPath)).toBe(true)
    expect(runner.indexOf(`name: "${NAME}"`)).toBeGreaterThan(runner.indexOf('name: "108_workspace_modules_legacy_flag_backfill"'))
  })

  it("is one idempotent table plus two async indexes, with no foreign key, trigger or existing-table change (DSQL rules)", () => {
    expect(statements).toHaveLength(3)
    expect(statements[0]).toMatch(/^CREATE TABLE IF NOT EXISTS agent_conversation_reviews \(/i)
    expect(statements[1]).toMatch(/^CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_agent_conversation_reviews_conversation_user ON agent_conversation_reviews\(conversation_id, user_id\)$/i)
    expect(statements[2]).toMatch(/^CREATE INDEX ASYNC IF NOT EXISTS idx_agent_conversation_reviews_user_workspace ON agent_conversation_reviews\(user_id, workspace_id\)$/i)
    expect(sql).not.toMatch(/REFERENCES|CREATE TYPE|CREATE TRIGGER|ALTER TABLE|\bWHERE\b|DROP|\bASC\b|\bDESC\b|SERIAL/i)
  })

  it("is mirrored in schema.prisma: the same table, columns and index names, and no @updatedAt", () => {
    const model = schema.slice(schema.indexOf("model AgentConversationReview {"))
    const body = model.slice(0, model.indexOf("\n}\n"))
    expect(body).toContain('@@map("agent_conversation_reviews")')
    expect(body).toContain('@@unique([conversationId, userId], map: "idx_agent_conversation_reviews_conversation_user")')
    expect(body).toContain('@@index([userId, workspaceId], map: "idx_agent_conversation_reviews_user_workspace")')
    expect(body).not.toContain("@updatedAt")
    expect(body).toContain('@map("reviewed_at")')
  })

  it("waits for the async index builds like 098 does, so the postcondition cannot fail on the first DSQL run", () => {
    expect(runner).toMatch(/const ASYNC_WAIT_MIGRATIONS = \[[^\]]*"109_agent_conversation_reviews"/)
    expect(runner).toMatch(/\["049_agent_identity"[^\]]*"109_agent_conversation_reviews"[^\]]*\]\.includes\(migration\.name\)/)
  })

  it("verifies before the receipt", () => {
    const assertion = runner.indexOf("migration.name === AGENT_CONVERSATION_REVIEWS_MIGRATION) await assertAgentConversationReviewsMigration")
    expect(assertion).toBeGreaterThan(-1)
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'))
  })

  describe("postcondition", () => {
    const columns = ["id", "conversation_id", "workspace_id", "user_id", "reviewed_at", "created_at", "updated_at"].map((column_name) => ({ column_name, is_nullable: "NO" }))
    const index = (name: string, overrides: Record<string, unknown> = {}) => {
      const unique = name.endsWith("conversation_user")
      return { valid: true, ready: true, unique, table_name: "agent_conversation_reviews", columns: unique ? ["conversation_id", "user_id"] : ["user_id", "workspace_id"], predicate: null, expression: null, ...overrides }
    }
    /** Answers the column query first, then one index query per call, in order. */
    const client = (cols: unknown[], indexes: unknown[][]) => {
      const query = vi.fn().mockResolvedValueOnce({ rows: cols })
      for (const rows of indexes) query.mockResolvedValueOnce({ rows })
      return { query } as never
    }
    const good = [[index("idx_agent_conversation_reviews_conversation_user")], [index("idx_agent_conversation_reviews_user_workspace")]]

    it("passes for the shape the migration creates", async () => {
      await expect(assertAgentConversationReviewsMigration(client(columns, good), "compass")).resolves.toBeUndefined()
    })

    it("fails closed on a missing column", async () => {
      await expect(assertAgentConversationReviewsMigration(client(columns.filter((c) => c.column_name !== "reviewed_at"), good), "compass")).rejects.toThrow(/reviewed_at/)
    })

    it("fails closed on an index that is missing, still building, or not unique", async () => {
      await expect(assertAgentConversationReviewsMigration(client(columns, [[], good[1]]), "compass")).rejects.toThrow(/conversation_user/)
      await expect(assertAgentConversationReviewsMigration(client(columns, [[index("idx_agent_conversation_reviews_conversation_user", { valid: false })], good[1]]), "compass")).rejects.toThrow(/not ready/)
      await expect(assertAgentConversationReviewsMigration(client(columns, [[index("idx_agent_conversation_reviews_conversation_user", { unique: false })], good[1]]), "compass")).rejects.toThrow(/conversation_user/)
    })
  })
})
