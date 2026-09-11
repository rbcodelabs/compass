import { expect, it, vi } from "vitest"
import type { PoolClient } from "pg"
import { readFileSync } from "node:fs"
import { assertAgentIdentityMigration } from "@/lib/migrations/agent-identity"

it("refuses a successful receipt when required columns are absent", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [] })
  await expect(assertAgentIdentityMigration({ query } as unknown as PoolClient, "preview")).rejects.toThrow(/missing required columns/)
})
it("uses additive DSQL schema and asynchronous indexes with no assignment backfill", () => {
  const sql = readFileSync("prisma/migrations/049_agent_identity/migration.sql", "utf8")
  expect(sql).not.toMatch(/FOREIGN KEY|DROP TABLE|UPDATE "tasks"|ALTER COLUMN/i)
  expect(sql.match(/CREATE (?:UNIQUE )?INDEX ASYNC/g)).toHaveLength(7)
  expect(sql).toContain('ADD COLUMN IF NOT EXISTS "assignee_agent_id" UUID')
  expect(sql).toContain('ADD COLUMN IF NOT EXISTS "agent_id" UUID')
})
