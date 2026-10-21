import { describe, expect, it, vi } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { PoolClient } from "pg"
import { assertAgentKindAndWorkspaceOwnerMigration, assertAgentOwnerUserNullableMigration } from "@/lib/migrations/agent-kind-and-workspace-owner"

/**
 * Static guards for 098_agent_kind_and_workspace_owner. The DDL that reaches Aurora DSQL is the
 * SQL file, not schema.prisma, so the two are pinned to each other here.
 */
const ROOT = process.cwd()
const NAME = "098_agent_kind_and_workspace_owner"
const runner = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8")
const sqlPath = path.join(ROOT, "prisma/migrations", NAME, "migration.sql")
const NULLABLE_NAME = "099_agent_owner_user_nullable"
const nullablePath = path.join(ROOT, "prisma/migrations", NULLABLE_NAME, "migration.sql")
const stripComments = (path: string) => (existsSync(path) ? readFileSync(path, "utf-8").split("\n").map((line) => line.replace(/--.*$/, "")).join("\n") : "")
const sql = stripComments(sqlPath)
const nullableStatements = stripComments(nullablePath).split(";").map((s) => s.trim()).filter(Boolean)
const statements = sql.split(";").map((s) => s.trim()).filter(Boolean)
const agentModel = schema.match(/model Agent \{[^}]*\}/)?.[0] ?? ""

describe(NAME, () => {
  it("is registered exactly once, directly after 097", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${NAME}"`, "g"))]).toHaveLength(1)
    expect(existsSync(sqlPath)).toBe(true)
    expect(runner.indexOf(`name: "${NAME}"`)).toBeGreaterThan(runner.indexOf('name: "097_entity_links_backfill_task"'))
  })

  it("is six bare nullable columns, then one async index (one DDL per statement)", () => {
    expect(statements).toHaveLength(7)
    const columns = [
      ["kind", "VARCHAR\\(20\\)"],
      ["owner_type", "VARCHAR\\(20\\)"],
      ["owner_workspace_id", "UUID"],
      ["instructions", "TEXT"],
      ["model", "VARCHAR\\(100\\)"],
      ["invoke_policy", "VARCHAR\\(30\\)"],
    ]
    columns.forEach(([column, type], index) => {
      // DSQL rejects any constraint or DEFAULT on ADD COLUMN, so each is bare and nullable.
      expect(statements[index]).toMatch(new RegExp(`^ALTER TABLE agents ADD COLUMN IF NOT EXISTS ${column} ${type}$`, "i"))
    })
    expect(statements[6]).toMatch(/^CREATE INDEX ASYNC IF NOT EXISTS agents_owner_workspace_id_idx ON agents\(owner_workspace_id\)$/i)
  })

  it("is idempotent and additive: IF NOT EXISTS on every create, no foreign keys, defaults, backfill or deletes", () => {
    for (const statement of statements.slice(0, 6)) expect(statement).toMatch(/IF NOT EXISTS/i)
    expect(sql).not.toMatch(/REFERENCES|CREATE TYPE|CREATE TRIGGER|\bWHERE\b|SERIAL|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bDEFAULT\b|\bNOT NULL\b(?!\s*;)/i)
    expect(sql).not.toMatch(/DROP COLUMN|DROP TABLE|RENAME/i)
  })

  it("registers 099 exactly once, directly after 098, as the lone DROP NOT NULL", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${NULLABLE_NAME}"`, "g"))]).toHaveLength(1)
    expect(runner.indexOf(`name: "${NULLABLE_NAME}"`)).toBeGreaterThan(runner.indexOf(`name: "${NAME}"`))
    expect(nullableStatements).toEqual(["ALTER TABLE agents ALTER COLUMN owner_user_id DROP NOT NULL"])
    expect(sql).not.toMatch(/owner_user_id/)
    // No async DDL, so it is deliberately absent from the async wait lists.
    expect(runner).not.toMatch(/"099_agent_owner_user_nullable"[^\n]*\]\.includes\(migration\.name\)/)
    expect(runner).toContain('migration.name === "099_agent_owner_user_nullable") await assertAgentOwnerUserNullableMigration')
  })

  it("maps the same columns and index in schema.prisma, with owner_user_id nullable and no @updatedAt", () => {
    expect(agentModel).toMatch(/ownerUserId\s+String\?\s+@map\("owner_user_id"\) @db\.Uuid/)
    expect(agentModel).toMatch(/kind\s+String\?\s+@db\.VarChar\(20\)/)
    expect(agentModel).toMatch(/ownerType\s+String\?\s+@map\("owner_type"\) @db\.VarChar\(20\)/)
    expect(agentModel).toMatch(/ownerWorkspaceId\s+String\?\s+@map\("owner_workspace_id"\) @db\.Uuid/)
    expect(agentModel).toMatch(/instructions\s+String\?\s+@db\.Text/)
    expect(agentModel).toMatch(/model\s+String\?\s+@db\.VarChar\(100\)/)
    expect(agentModel).toMatch(/invokePolicy\s+String\?\s+@map\("invoke_policy"\) @db\.VarChar\(30\)/)
    expect(agentModel).toContain('@@index([ownerWorkspaceId], map: "agents_owner_workspace_id_idx")')
    expect(agentModel).not.toMatch(/@updatedAt|@relation/)
  })

  it("waits for its async index and verifies before the receipt", () => {
    expect(runner).toMatch(/const ASYNC_WAIT_MIGRATIONS = \[[^\]]*"098_agent_kind_and_workspace_owner"/)
    expect(runner).toMatch(/\["049_agent_identity"[^\]]*"098_agent_kind_and_workspace_owner"[^\]]*\]\.includes\(migration\.name\)/)
    const assertion = runner.indexOf('migration.name === "098_agent_kind_and_workspace_owner") await assertAgentKindAndWorkspaceOwnerMigration')
    expect(assertion).toBeGreaterThan(-1)
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'))
  })
})

/** A client whose catalog answers the postcondition's two queries. */
function client(options: {
  columns?: { column_name: string; is_nullable: string; data_type: string }[]
  index?: Partial<{ valid: boolean; ready: boolean; unique: boolean; table_name: string; columns: string[]; predicate: string | null }> | null
}): PoolClient {
  const healthyColumns = [
    { column_name: "owner_user_id", is_nullable: "YES", data_type: "uuid" },
    { column_name: "kind", is_nullable: "YES", data_type: "character varying" },
    { column_name: "owner_type", is_nullable: "YES", data_type: "character varying" },
    { column_name: "owner_workspace_id", is_nullable: "YES", data_type: "uuid" },
    { column_name: "instructions", is_nullable: "YES", data_type: "text" },
    { column_name: "model", is_nullable: "YES", data_type: "character varying" },
    { column_name: "invoke_policy", is_nullable: "YES", data_type: "character varying" },
  ]
  const healthyIndex = { valid: true, ready: true, unique: false, table_name: "agents", columns: ["owner_workspace_id"], predicate: null }
  return {
    query: vi.fn(async (text: string) =>
      text.includes("information_schema.columns")
        ? { rows: options.columns ?? healthyColumns }
        : { rows: options.index === null ? [] : [{ ...healthyIndex, ...options.index }] },
    ),
  } as unknown as PoolClient
}

describe(`${NAME} postcondition`, () => {
  it("passes when every column is present and nullable and the index is valid and ready", async () => {
    await expect(assertAgentKindAndWorkspaceOwnerMigration(client({}), "s")).resolves.toBeUndefined()
  })

  it("fails when a new column is missing or has the wrong shape", async () => {
    const base = [
      { column_name: "owner_user_id", is_nullable: "YES", data_type: "uuid" },
      { column_name: "kind", is_nullable: "YES", data_type: "character varying" },
      { column_name: "owner_type", is_nullable: "YES", data_type: "character varying" },
      { column_name: "owner_workspace_id", is_nullable: "YES", data_type: "uuid" },
      { column_name: "instructions", is_nullable: "YES", data_type: "text" },
      { column_name: "model", is_nullable: "YES", data_type: "character varying" },
      { column_name: "invoke_policy", is_nullable: "YES", data_type: "character varying" },
    ]
    await expect(assertAgentKindAndWorkspaceOwnerMigration(client({ columns: base.filter((c) => c.column_name !== "invoke_policy") }), "s")).rejects.toThrow(/invoke_policy/)
    await expect(assertAgentKindAndWorkspaceOwnerMigration(client({ columns: base.map((c) => (c.column_name === "kind" ? { ...c, is_nullable: "NO" } : c)) }), "s")).rejects.toThrow(/kind/)
    await expect(assertAgentKindAndWorkspaceOwnerMigration(client({ columns: base.map((c) => (c.column_name === "owner_workspace_id" ? { ...c, data_type: "text" } : c)) }), "s")).rejects.toThrow(/owner_workspace_id/)
  })

  it.each([
    ["missing", null],
    ["not yet valid", { valid: false }],
    ["not yet ready", { ready: false }],
    ["unique", { unique: true }],
    ["on the wrong columns", { columns: ["owner_user_id"] }],
    ["partial", { predicate: "(status = 'ACTIVE')" }],
  ])("fails when the owner_workspace_id index is %s", async (_label, index) => {
    await expect(assertAgentKindAndWorkspaceOwnerMigration(client({ index }), "s")).rejects.toThrow(/agents_owner_workspace_id_idx/)
  })
})

describe(`${NULLABLE_NAME} postcondition`, () => {
  const client = (rows: { is_nullable: string }[]) => ({ query: vi.fn(async () => ({ rows })) }) as unknown as PoolClient
  it("passes when owner_user_id is nullable", async () => {
    await expect(assertAgentOwnerUserNullableMigration(client([{ is_nullable: "YES" }]), "s")).resolves.toBeUndefined()
  })
  it("fails when owner_user_id is still NOT NULL (a DSQL that refused the statement must not record success)", async () => {
    await expect(assertAgentOwnerUserNullableMigration(client([{ is_nullable: "NO" }]), "s")).rejects.toThrow(/owner_user_id/)
  })
  it("fails when the column is missing", async () => {
    await expect(assertAgentOwnerUserNullableMigration(client([]), "s")).rejects.toThrow(/owner_user_id/)
  })
})
