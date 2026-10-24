import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { PoolClient } from "pg"
import {
  LEGACY_FLAG_MODULES, WORKSPACE_MODULES_LEGACY_FLAG_BACKFILL_MIGRATION, WORKSPACE_MODULES_MIGRATION,
  assertLegacyFlagBackfill, backfillLaunchWorkflowModules, backfillLegacyFlagModules, legacyFlagsSetIn,
} from "@/lib/migrations/workspace-modules"
import { MODULE_KEYS } from "@/lib/modules/registry"
import { assertReviewedManagedManifest, assertReviewedMigrationCode } from "@/lib/preview-automation/managed-manifest"
import { partitionPendingMigrations, selectMigrationsToRun } from "@/lib/migrations/runner"

const ROOT = process.cwd()
const runner = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8")
const strip = (name: string) => readFileSync(path.join(ROOT, "prisma/migrations", name, "migration.sql"), "utf-8").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n")

describe(WORKSPACE_MODULES_MIGRATION, () => {
  const statements = strip(WORKSPACE_MODULES_MIGRATION).split(";").map((s) => s.trim()).filter(Boolean)

  it("is a table and one unique async index, DSQL-safe, with no foreign key", () => {
    expect(statements).toHaveLength(2)
    expect(statements[0]).toMatch(/^CREATE TABLE IF NOT EXISTS workspace_modules \(/i)
    expect(statements[1]).toMatch(/^CREATE UNIQUE INDEX ASYNC IF NOT EXISTS workspace_modules_workspace_id_module_key_key ON workspace_modules\(workspace_id, module_key\)$/i)
    expect(strip(WORKSPACE_MODULES_MIGRATION)).not.toMatch(/REFERENCES|FOREIGN KEY|\bWHERE\b|SERIAL|DROP |TRIGGER/i)
  })

  it("is mapped in schema.prisma and leaves the legacy launch column in place", () => {
    const model = schema.match(/model WorkspaceModule \{[\s\S]*?\n\}/)?.[0] ?? ""
    expect(model).toContain('@@map("workspace_modules")')
    expect(model).toContain('@@unique([workspaceId, moduleKey], map: "workspace_modules_workspace_id_module_key_key")')
    expect(model).not.toMatch(/@updatedAt|@relation/)
    expect(schema).toContain('launchWorkflowEnabled Boolean?               @default(false) @map("launch_workflow_enabled")')
  })

  it("is registered, waits for its async index and verifies before the receipt", () => {
    expect([...runner.matchAll(/name:\s*"107_workspace_modules"/g)]).toHaveLength(1)
    expect(runner).toMatch(/const ASYNC_WAIT_MIGRATIONS = \[[^\]]*"107_workspace_modules"/)
    expect(runner).toMatch(/\["049_agent_identity"[^\]]*"107_workspace_modules"[^\]]*\]\.includes\(migration\.name\)/)
    const assertion = runner.indexOf("await assertWorkspaceModulesMigration(client, schema)")
    expect(assertion).toBeGreaterThan(-1)
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'))
  })

  it("is in the reviewed managed manifest with its hook digest, and runs on an untargeted POST", () => {
    const entries = partitionPendingMigrations("compass_pr_1_aaaaaaaaaaaa", new Set()).pending
    expect(() => assertReviewedManagedManifest(entries)).not.toThrow()
    expect(() => assertReviewedMigrationCode(WORKSPACE_MODULES_MIGRATION)).not.toThrow()
    expect(selectMigrationsToRun([{ name: WORKSPACE_MODULES_MIGRATION }]).map((m) => m.name)).toEqual([WORKSPACE_MODULES_MIGRATION])
  })
})

describe(WORKSPACE_MODULES_LEGACY_FLAG_BACKFILL_MIGRATION, () => {
  it("contains no executable SQL and is explicit-only", () => {
    expect(strip(WORKSPACE_MODULES_LEGACY_FLAG_BACKFILL_MIGRATION).trim()).toBe("")
    expect(existsSync(path.join(ROOT, "prisma/migrations", WORKSPACE_MODULES_LEGACY_FLAG_BACKFILL_MIGRATION, "migration.sql"))).toBe(true)
    const name = WORKSPACE_MODULES_LEGACY_FLAG_BACKFILL_MIGRATION
    expect(selectMigrationsToRun([{ name }, { name: WORKSPACE_MODULES_MIGRATION }]).map((m) => m.name)).toEqual([WORKSPACE_MODULES_MIGRATION])
    expect(selectMigrationsToRun([{ name }], name).map((m) => m.name)).toEqual([name])
    expect(() => assertReviewedMigrationCode(name)).not.toThrow()
  })

  it("maps only real modules, and only an exact '1' counts", () => {
    for (const { moduleKey } of LEGACY_FLAG_MODULES) expect(MODULE_KEYS).toContain(moduleKey)
    expect(legacyFlagsSetIn({ COMPASS_RESEARCH_CAPTURE_ENABLED: "1", FOLLOWING_ENABLED: "true", WORKSPACE_UPDATES_ENABLED: "0", COMPASS_PM_INTERVIEW_ENABLED: "" })).toEqual(["research_capture"])
    expect(legacyFlagsSetIn({})).toEqual([])
  })
})

/** An in-memory stand-in for the three statements the backfill issues. */
function fakeDb(workspaces: { id: string; launch: boolean }[], rows: { workspace: string; key: string; enabled: boolean }[] = [], tableExists = true) {
  const client = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes("information_schema.tables")) return { rows: tableExists ? [{}] : [] }
      if (sql.includes("SELECT w.id")) {
        const key = params[0] as string
        const launchOnly = sql.includes("launch_workflow_enabled IS TRUE")
        return { rows: workspaces.filter((w) => (!launchOnly || w.launch) && !rows.some((r) => r.workspace === w.id && r.key === key)).sort((a, b) => a.id.localeCompare(b.id)).map((w) => ({ id: w.id })) }
      }
      if (sql.startsWith("INSERT INTO")) {
        rows.push({ workspace: params[0] as string, key: params[1] as string, enabled: true })
        return { rows: [] }
      }
      if (sql.includes("count(*)")) {
        const key = params[0] as string
        return { rows: [{ n: String(workspaces.filter((w) => !rows.some((r) => r.workspace === w.id && r.key === key)).length) }] }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    },
  } as unknown as PoolClient
  return { client, rows }
}

describe("backfillLaunchWorkflowModules", () => {
  it("carries only workspaces with the legacy column on, once", async () => {
    const { client, rows } = fakeDb([{ id: "a", launch: true }, { id: "b", launch: false }, { id: "c", launch: true }])
    expect(await backfillLaunchWorkflowModules(client, "s", [])).toBe(2)
    expect(rows.map((r) => r.workspace).sort()).toEqual(["a", "c"])
    expect(rows.every((r) => r.key === "launch_workflow" && r.enabled)).toBe(true)
    expect(await backfillLaunchWorkflowModules(client, "s", [])).toBe(0)
  })

  it("never overwrites a row an administrator already set", async () => {
    const { client, rows } = fakeDb([{ id: "a", launch: true }], [{ workspace: "a", key: "launch_workflow", enabled: false }])
    await backfillLaunchWorkflowModules(client, "s", [])
    expect(rows).toEqual([{ workspace: "a", key: "launch_workflow", enabled: false }])
  })
})

describe("backfillLegacyFlagModules", () => {
  it("enables only the modules whose flag is exactly 1, in every workspace, without touching existing rows", async () => {
    const { client, rows } = fakeDb([{ id: "a", launch: false }, { id: "b", launch: false }], [{ workspace: "b", key: "research_capture", enabled: false }])
    const log: string[] = []
    const env = { COMPASS_RESEARCH_CAPTURE_ENABLED: "1", WORKSPACE_UPDATES_ENABLED: "1", FOLLOWING_ENABLED: "yes" }
    expect(await backfillLegacyFlagModules(client, "s", log, env)).toEqual({ research_capture: 1, workspace_updates: 2 })
    expect(rows.filter((r) => r.key === "research_capture")).toEqual([{ workspace: "b", key: "research_capture", enabled: false }, { workspace: "a", key: "research_capture", enabled: true }])
    expect(rows.some((r) => r.key === "following")).toBe(false)
    await expect(assertLegacyFlagBackfill(client, "s", env)).resolves.toBeUndefined()
  })

  it("is conservative: with no flag set it writes nothing", async () => {
    const { client, rows } = fakeDb([{ id: "a", launch: false }])
    const log: string[] = []
    expect(await backfillLegacyFlagModules(client, "s", log, {})).toEqual({})
    expect(rows).toEqual([])
    expect(log.join("\n")).toMatch(/nothing to carry over/)
  })

  it("does not enable a module's dependencies on its behalf", async () => {
    const { client, rows } = fakeDb([{ id: "a", launch: false }])
    await backfillLegacyFlagModules(client, "s", [], { COMPASS_RESEARCH_BROWSER_VOICE_ENABLED: "1" })
    expect(rows.map((r) => r.key)).toEqual(["research_voice_browser"])
  })

  it("refuses to run before 107 is applied", async () => {
    const { client } = fakeDb([], [], false)
    await expect(backfillLegacyFlagModules(client, "s", [], { FOLLOWING_ENABLED: "1" })).rejects.toThrow(/apply 107_workspace_modules first/)
  })

  it("the postcondition fails when a flagged module is missing from a workspace", async () => {
    const { client } = fakeDb([{ id: "a", launch: false }])
    await expect(assertLegacyFlagBackfill(client, "s", { FOLLOWING_ENABLED: "1" })).rejects.toThrow(/no following module row/)
  })
})
