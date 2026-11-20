import { randomUUID } from "node:crypto"
import { performance } from "node:perf_hooks"
import { Pool, type PoolClient } from "pg"
import { describe, expect, it } from "vitest"
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"
import { inspectLegacyDecisionReviewRepair } from "@/lib/migrations/legacy-decision-review-repair"
import { createInspectionPool } from "@/lib/migrations/inspection-pool"

describe.skipIf(!integrationDatabaseUrl)("real adapter inspection query timeout cleanup", () => {
  it("settles a stalled query and closes its checkout while the caller's sole connection remains held", async () => {
    const config = { connectionString: integrationDatabaseUrl, max: 1 }
    const caller = new Pool(config)
    const admin = new Pool({ connectionString: integrationDatabaseUrl, max: 2 })
    const schema = `inspection_${randomUUID().replaceAll("-", "")}`
    const workspaceId = randomUUID()
    let owned: Pool | undefined
    let created = false
    let held: PoolClient | undefined
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`)
      created = true
      // A real PostgreSQL query stalls inside workspace.findUnique through the real Prisma adapter.
      await admin.query(`CREATE VIEW "${schema}".workspaces AS SELECT '${workspaceId}'::text AS id FROM pg_sleep(8)`)
      held = await caller.connect()
      const started = performance.now()
      await expect(inspectLegacyDecisionReviewRepair(caller, schema, { workspaceId, requests: [] }, () => {
        owned = createInspectionPool({ ...config, application_name: schema }, true)
        return owned
      })).rejects.toThrow()
      const elapsed = performance.now() - started
      expect(elapsed).toBeGreaterThan(1000)
      expect(elapsed).toBeLessThan(12000)
      expect(owned!.totalCount).toBe(0)
      expect(owned!.waitingCount).toBe(0)
      const sockets = await admin.query<{ count: string }>("SELECT count(*)::text AS count FROM pg_stat_activity WHERE application_name=$1", [schema])
      expect(sockets.rows[0]?.count).toBe("0")
      console.info(JSON.stringify({ event: "inspection-timeout-cleanup", elapsedMs: Math.round(elapsed), inspectionConnections: owned!.totalCount, waiting: owned!.waitingCount, serverConnections: Number(sockets.rows[0]?.count) }))
      expect(caller.totalCount).toBe(1)
      expect(caller.idleCount).toBe(0)
    } finally {
      held?.release()
      await caller.end()
      if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
      await admin.end()
    }
  }, 20000)
})
