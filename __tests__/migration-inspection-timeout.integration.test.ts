import { randomUUID } from "node:crypto"
import { performance } from "node:perf_hooks"
import { setTimeout as sleep } from "node:timers/promises"
import { Pool, type PoolClient } from "pg"
import { describe, expect, it } from "vitest"
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"
import { parseLegacyDecisionRepairManifest } from "@/lib/legacy-decision-repair"
import { inspectLegacyDecisionReviewRepair } from "@/lib/migrations/legacy-decision-review-repair"
import { createInspectionPool } from "@/lib/migrations/inspection-pool"

/** Read the known Prisma/adapter error links so a generic rejection cannot stand in for a query timeout. */
function timeoutSignals(error: unknown, depth = 0): string {
  if (typeof error !== "object" || error === null || depth > 6) return ""
  const fields = error as Record<string, unknown>
  const own = ["code", "message", "originalCode", "originalMessage"].map((key) => typeof fields[key] === "string" ? fields[key] : "")
  return [...own, ...["cause", "meta", "driverAdapterError"].map((key) => timeoutSignals(fields[key], depth + 1))].join(" ")
}

describe.skipIf(!integrationDatabaseUrl)("real adapter inspection query timeout cleanup", () => {
  it("observes the stalled query, requires a timeout, and closes its checkout while the caller's sole connection remains held", async () => {
    const workspaceId = randomUUID()
    const manifest = parseLegacyDecisionRepairManifest({
      workspaceId,
      requests: [{ requestId: randomUUID(), expectedRevisionId: randomUUID(), expectedFingerprint: "a".repeat(64), references: [] }],
    })
    const config = { connectionString: integrationDatabaseUrl, max: 1 }
    const caller = new Pool(config)
    const admin = new Pool({ connectionString: integrationDatabaseUrl, max: 2, query_timeout: 1000, statement_timeout: 1000 })
    const schema = "inspection_" + randomUUID().replaceAll("-", "")
    let owned: Pool | undefined
    let created = false
    let held: PoolClient | undefined
    let inspection: Promise<{ succeeded: boolean; error?: unknown }> | undefined
    try {
      await admin.query('CREATE SCHEMA "' + schema + '"')
      created = true
      // UUID matches Prisma's workspace id type; pg_sleep makes a successfully submitted query observable.
      await admin.query('CREATE VIEW "' + schema + '".workspaces AS SELECT \'' + workspaceId + '\'::uuid AS id FROM pg_sleep(8)')
      held = await caller.connect()
      const started = performance.now()
      inspection = inspectLegacyDecisionReviewRepair(caller, schema, manifest, () => {
        owned = createInspectionPool({ ...config, application_name: schema }, true)
        return owned
      }).then(() => ({ succeeded: true }), (error: unknown) => ({ succeeded: false, error }))

      let observedQuery = false
      const observationDeadline = performance.now() + 4000
      while (performance.now() < observationDeadline) {
        const active = await admin.query<{ query: string; wait_event: string | null }>(
          "SELECT query, wait_event FROM pg_stat_activity WHERE application_name=$1 AND state='active'", [schema],
        )
        observedQuery = active.rows.some((row) => row.query.includes(schema) && row.query.includes("workspaces") && row.wait_event === "PgSleep")
        if (observedQuery) break
        await sleep(25)
      }
      expect(observedQuery, "the real workspace query must reach PostgreSQL and enter pg_sleep before a timeout can count").toBe(true)

      const outcome = await inspection
      const elapsed = performance.now() - started
      expect(outcome.succeeded).toBe(false)
      expect(timeoutSignals(outcome.error)).toMatch(/57014|Query read timeout|statement timeout|Transaction[^]*?(?:timed out|expired)/i)
      expect(elapsed).toBeGreaterThan(1000)
      expect(elapsed).toBeLessThan(12000)
      expect(owned!.totalCount).toBe(0)
      expect(owned!.waitingCount).toBe(0)
      const sockets = await admin.query<{ count: string }>("SELECT count(*)::text AS count FROM pg_stat_activity WHERE application_name=$1", [schema])
      expect(sockets.rows[0]?.count).toBe("0")
      console.info(JSON.stringify({ event: "inspection-timeout-cleanup", observedQuery, elapsedMs: Math.round(elapsed), inspectionConnections: owned!.totalCount, waiting: owned!.waitingCount, serverConnections: Number(sockets.rows[0]?.count) }))
      expect(caller.totalCount).toBe(1)
      expect(caller.idleCount).toBe(0)
    } finally {
      await inspection
      held?.release()
      await caller.end()
      if (created) await admin.query('DROP SCHEMA "' + schema + '" CASCADE')
      await admin.end()
    }
  }, 20000)
})
