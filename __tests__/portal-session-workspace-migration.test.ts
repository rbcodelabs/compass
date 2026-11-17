import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { assertPortalSessionWorkspaceMigration } from "@/lib/migrations/portal-session-workspace"

/**
 * Static guards for 125_portal_session_workspace (GHSA-8734-6xx5-cwf6, finding 8). The DDL that reaches Aurora DSQL is the SQL
 * file, not schema.prisma, so the two are pinned to each other here.
 */
const NAME = "125_portal_session_workspace"
const ROOT = process.cwd()
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf-8")
const runner = read("lib/migrations/runner.ts")
const schema = read("prisma/schema.prisma")
const statements = read(`prisma/migrations/${NAME}/migration.sql`)
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean)
const names = [...runner.matchAll(/name:\s*"(\d{3}_[a-z0-9_]+)"/g)].map((match) => match[1])

describe(NAME, () => {
  it("is registered exactly once, directly after the previous migration", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${NAME}"`, "g"))]).toHaveLength(1)
    expect(names[names.indexOf(NAME) - 1]).toBe("124_agent_web_fetches")
  })

  it("is exactly two bare nullable idempotent ADD COLUMNs: no default, NOT NULL, index, FK, backfill, delete or drop (DSQL, non-destructive)", () => {
    expect(statements).toEqual([
      "ALTER TABLE portal_sessions ADD COLUMN IF NOT EXISTS workspace_id UUID",
      "ALTER TABLE portal_verification_tokens ADD COLUMN IF NOT EXISTS workspace_id UUID",
    ])
    expect(statements.join(";\n")).not.toMatch(/NOT NULL|DEFAULT|REFERENCES|FOREIGN KEY|CHECK|INDEX|UPDATE|INSERT|DELETE|DROP|TRUNCATE|WHERE/i)
  })

  it("runs its postcondition before the completion receipt", () => {
    const call = runner.indexOf(`migration.name === "${NAME}") await assertPortalSessionWorkspaceMigration`)
    expect(call).toBeGreaterThan(-1)
    expect(call).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'))
  })

  it("matches schema.prisma: nullable uuid workspace_id on both models, with no relation and no index", () => {
    for (const model of ["PortalSession", "PortalVerificationToken"]) {
      const body = schema.match(new RegExp(`model ${model} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? ""
      expect(body, model).toMatch(/workspaceId\s+String\?\s+@map\("workspace_id"\)\s+@db\.Uuid/)
      expect(body, model).not.toMatch(/@@index\(\[workspaceId|Workspace\s+@relation/)
    }
  })
})

type Row = { data_type: string; is_nullable: string }
/** One answer per information_schema probe, in the order 125 asks: portal_sessions, then portal_verification_tokens. */
const clientFor = (answers: (Row | undefined)[]) => {
  let call = 0
  return { query: async () => ({ rows: answers[call++] ? [answers[call - 1]] : [] }) } as never
}

describe("assertPortalSessionWorkspaceMigration", () => {
  const good: Row = { data_type: "uuid", is_nullable: "YES" }
  it("accepts both columns as nullable uuid", async () => {
    await expect(assertPortalSessionWorkspaceMigration(clientFor([good, good]), "s")).resolves.toBeUndefined()
  })
  it("fails closed on a missing, mistyped or NOT NULL column on either table", async () => {
    await expect(assertPortalSessionWorkspaceMigration(clientFor([undefined, good]), "s")).rejects.toThrow(/portal_sessions.workspace_id missing/)
    await expect(assertPortalSessionWorkspaceMigration(clientFor([good, undefined]), "s")).rejects.toThrow(/portal_verification_tokens.workspace_id missing/)
    await expect(assertPortalSessionWorkspaceMigration(clientFor([{ ...good, data_type: "text" }, good]), "s")).rejects.toThrow(/type postcondition/)
    await expect(assertPortalSessionWorkspaceMigration(clientFor([good, { ...good, is_nullable: "NO" }]), "s")).rejects.toThrow(/NOT NULL/)
  })
})
