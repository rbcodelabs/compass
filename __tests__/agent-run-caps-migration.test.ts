import { describe, expect, it, vi } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { PoolClient } from "pg"
import { assertAgentRunCapsMigration } from "@/lib/migrations/agent-run-caps"
import { assertReviewedManagedManifest, assertReviewedMigrationCode } from "@/lib/preview-automation/managed-manifest"
import { partitionPendingMigrations } from "@/lib/migrations/runner"

/** Static guards for 102_agent_run_caps: the DDL that reaches Aurora DSQL is the SQL file, so it is pinned to schema.prisma here. */
const ROOT = process.cwd()
const NAME = "102_agent_run_caps"
const runner = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8")
const sqlPath = path.join(ROOT, "prisma/migrations", NAME, "migration.sql")
const sql = existsSync(sqlPath) ? readFileSync(sqlPath, "utf-8").split("\n").map((line) => line.replace(/--.*$/, "")).join("\n") : ""
const statements = sql.split(";").map((s) => s.trim()).filter(Boolean)
const agentModel = schema.match(/model Agent \{[\s\S]*?\n\}/)?.[0] ?? ""

describe(NAME, () => {
  it("is registered exactly once, between 101 and 103", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${NAME}"`, "g"))]).toHaveLength(1)
    expect(existsSync(sqlPath)).toBe(true)
    const at = runner.indexOf(`name: "${NAME}"`)
    expect(at).toBeGreaterThan(runner.indexOf('name: "101_agent_default_selection"'))
    expect(at).toBeLessThan(runner.indexOf('name: "103_shared_compass_agent_bootstrap"'))
  })

  it("is two bare nullable integer columns, one DDL per statement", () => {
    expect(statements).toEqual([
      "ALTER TABLE agents ADD COLUMN IF NOT EXISTS max_concurrent_runs INTEGER",
      "ALTER TABLE agents ADD COLUMN IF NOT EXISTS max_runs_per_day INTEGER",
    ])
  })

  it("is additive: no defaults, NOT NULL, foreign keys, indexes, backfill or destructive DDL", () => {
    expect(sql).not.toMatch(/REFERENCES|\bDEFAULT\b|\bNOT NULL\b|\bINDEX\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|DROP |RENAME/i)
  })

  it("maps the same columns in schema.prisma as nullable ints with no relation", () => {
    expect(agentModel).toMatch(/maxConcurrentRuns\s+Int\?\s+@map\("max_concurrent_runs"\)/)
    expect(agentModel).toMatch(/maxRunsPerDay\s+Int\?\s+@map\("max_runs_per_day"\)/)
  })

  it("has no index to wait for, and verifies before the receipt", () => {
    expect(runner).not.toMatch(/const ASYNC_WAIT_MIGRATIONS = \[[^\]]*"102_agent_run_caps"/)
    const assertion = runner.indexOf('migration.name === "102_agent_run_caps") await assertAgentRunCapsMigration')
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

const healthy = [
  { column_name: "max_concurrent_runs", is_nullable: "YES", data_type: "integer" },
  { column_name: "max_runs_per_day", is_nullable: "YES", data_type: "integer" },
  { column_name: "name", is_nullable: "NO", data_type: "character varying" },
]
const client = (rows = healthy) => ({ query: vi.fn(async () => ({ rows })) }) as unknown as PoolClient

describe(`${NAME} postcondition`, () => {
  it("passes when both columns are nullable integers", async () => {
    await expect(assertAgentRunCapsMigration(client(), "s")).resolves.toBeUndefined()
  })

  it("fails when a column is missing", async () => {
    await expect(assertAgentRunCapsMigration(client(healthy.filter((c) => c.column_name !== "max_runs_per_day")), "s")).rejects.toThrow(/max_runs_per_day/)
  })

  it("fails when a column is NOT NULL or the wrong type", async () => {
    await expect(assertAgentRunCapsMigration(client(healthy.map((c) => (c.column_name === "max_concurrent_runs" ? { ...c, is_nullable: "NO" } : c))), "s")).rejects.toThrow(/max_concurrent_runs/)
    await expect(assertAgentRunCapsMigration(client(healthy.map((c) => (c.column_name === "max_runs_per_day" ? { ...c, data_type: "text" } : c))), "s")).rejects.toThrow(/max_runs_per_day/)
  })
})
