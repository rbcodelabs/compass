import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { assertWorkspaceModulesMigration, backfillLaunchWorkflowModules } from "@/lib/migrations/workspace-modules"
import { applyMigrations } from "@/lib/migrations/runner"
import { replayAllMigrations } from "./helpers/replay-migrations"

/**
 * 107 and 108 through the registered runner, on a throwaway schema of this suite's own, after every earlier migration has been replayed.
 *
 * Set WORKSPACE_MODULES_DATABASE_URL to the local compass_e2e database to enable. The guard keeps it from ever pointing anywhere else:
 * this suite creates and drops schemas, which must never happen against DSQL or a shared database.
 */
const databaseUrl = process.env.WORKSPACE_MODULES_DATABASE_URL
const BACKFILL = "108_workspace_modules_legacy_flag_backfill"

describe.skipIf(!databaseUrl)("workspace modules migrations through the registered runner", () => {
  const schema = `workspace_modules_test_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const previous = process.env.DATABASE_URL
  const previousFlag = process.env.FOLLOWING_ENABLED
  let owned = false
  const launchOn = randomUUID()
  const launchOff = randomUUID()

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!["postgresql:", "postgres:"].includes(url.protocol) || !["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e" || url.searchParams.has("schema")) {
      throw new Error("Only isolated local compass_e2e is allowed")
    }
    process.env.DATABASE_URL = databaseUrl
    await pool.query(`CREATE SCHEMA "${schema}"`)
    owned = true
  }, 120_000)

  afterAll(async () => {
    if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await pool.end()
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
    if (previousFlag === undefined) delete process.env.FOLLOWING_ENABLED
    else process.env.FOLLOWING_ENABLED = previousFlag
  })

  it("replays every migration and earns the 107 receipt with a valid table and index", async () => {
    const result = await replayAllMigrations(pool, schema)
    expect((await result.json()).error).toBeUndefined()
    const client = await pool.connect()
    try {
      await assertWorkspaceModulesMigration(client, schema)
    } finally {
      client.release()
    }
  }, 600_000)

  it("carries the legacy launch column over once and leaves other workspaces alone", async () => {
    const org = randomUUID()
    for (const [id, launch] of [[launchOn, true], [launchOff, false]] as const) {
      await pool.query(`INSERT INTO "${schema}".workspaces (id, organization_id, slug, name, launch_workflow_enabled, created_at, updated_at) VALUES ($1, $2, $3, $3, $4, NOW(), NOW())`, [id, org, `w-${id.slice(0, 8)}`, launch])
    }
    const client = await pool.connect()
    try {
      expect(await backfillLaunchWorkflowModules(client, schema, [])).toBe(1)
      expect(await backfillLaunchWorkflowModules(client, schema, [])).toBe(0)
    } finally {
      client.release()
    }
    const rows = await pool.query(`SELECT workspace_id, enabled FROM "${schema}".workspace_modules WHERE module_key = 'launch_workflow'`)
    expect(rows.rows).toEqual([{ workspace_id: launchOn, enabled: true }])
  })

  it("108 enables the flagged module in every workspace, only when named, and is idempotent", async () => {
    process.env.FOLLOWING_ENABLED = "1"
    const first = await applyMigrations(pool, schema, BACKFILL)
    expect(first.status).toBe(200)
    const rows = await pool.query(`SELECT workspace_id FROM "${schema}".workspace_modules WHERE module_key = 'following' AND enabled`)
    expect(rows.rows.map((r) => r.workspace_id).sort()).toEqual([launchOn, launchOff].sort())
    const again = await applyMigrations(pool, schema, BACKFILL)
    expect(again.status).toBe(200)
    const receipts = await pool.query(`SELECT 1 FROM "${schema}"._prisma_migrations WHERE migration_name = $1`, [BACKFILL])
    expect(receipts.rows).toHaveLength(1)
  })
})
