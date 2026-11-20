import type { Pool } from "pg"
import { beforeEach, describe, expect, it, vi } from "vitest"

const repair = vi.hoisted(() => ({ apply: vi.fn(), inspect: vi.fn() }))
vi.mock("@/lib/migrations/legacy-decision-review-repair", () => ({
  LEGACY_DECISION_REVIEW_REPAIR_MIGRATION: "048_legacy_decision_review_repair",
  applyLegacyDecisionReviewRepair: repair.apply,
  getLegacyDecisionReviewRepairStatus: repair.inspect,
}))
// Exercise DSQL's ASYNC branch without opening a database connection.
vi.mock("@/lib/db-url", () => ({ usesPlainPostgres: () => false }))

import { applyMigrations } from "@/lib/migrations/runner"

type AsyncFixture = { jobId?: string; jobStatus?: string; invalidIndex?: boolean; waitError?: Error }

function migrationPool(fixture: AsyncFixture = {}) {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (/CREATE\s+UNIQUE\s+INDEX\s+ASYNC/i.test(sql)) {
      return { rows: fixture.jobId ? [{ job_id: fixture.jobId }] : [] }
    }
    if (sql === "CALL sys.wait_for_job($1)") {
      if (fixture.waitError) throw fixture.waitError
      return { rows: [] }
    }
    if (sql === "SELECT status FROM sys.jobs WHERE job_id = $1") {
      return { rows: fixture.jobStatus ? [{ status: fixture.jobStatus }] : [] }
    }
    if (sql.includes("i.indisvalid AS valid") && sql.includes("c.relname=$2")) {
      const events = values?.[1] === "workspace_update_events_revision_key"
      return { rows: [{
        valid: !fixture.invalidIndex, ready: !fixture.invalidIndex, unique: true,
        table_name: events ? "workspace_update_events" : "workspace_updates_read_state",
        columns: events ? ["workspace_id", "revision"] : ["workspace_id", "user_id"],
        predicate: null, expression: null,
      }] }
    }
    return { rows: [] }
  })
  const release = vi.fn()
  const pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool
  const finished = () => query.mock.calls.filter(([sql]) => /UPDATE .*_prisma_migrations SET finished_at/.test(sql))
  return { pool, query, release, finished }
}

beforeEach(() => {
  vi.clearAllMocks()
  repair.apply.mockResolvedValue({ workspaceStatus: "NOT_PRESENT", requests: [] })
})

describe("048 explicit apply stays strict", () => {
  it("returns failure and leaves the attempt unfinished when the repair throws", async () => {
    repair.apply.mockRejectedValueOnce(new Error("repair connection lost"))
    const fixture = migrationPool()
    const response = await applyMigrations(fixture.pool, "compass_prod", "048_legacy_decision_review_repair")

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: "repair connection lost" })
    expect(repair.apply).toHaveBeenCalledOnce()
    expect(repair.inspect).not.toHaveBeenCalled()
    expect(fixture.query.mock.calls.some(([sql]) => /INSERT INTO .*_prisma_migrations/.test(sql))).toBe(true)
    expect(fixture.finished()).toHaveLength(0)
    expect(fixture.release).toHaveBeenCalledOnce()
  })
})

describe("060 DSQL ASYNC completion and receipt safety", () => {
  it("accepts no job for existing indexes only after both exact postconditions pass", async () => {
    const fixture = migrationPool()
    const response = await applyMigrations(fixture.pool, "compass_prod", "060_workspace_updates")

    expect(await response.json()).not.toHaveProperty("error")
    expect(response.status).toBe(200)
    expect(fixture.query.mock.calls.filter(([sql]) => /CREATE UNIQUE INDEX ASYNC/.test(sql))).toHaveLength(2)
    expect(fixture.query.mock.calls.filter(([sql]) => sql.includes("i.indisvalid AS valid") && sql.includes("c.relname=$2"))).toHaveLength(2)
    expect(fixture.query).not.toHaveBeenCalledWith("CALL sys.wait_for_job($1)", expect.anything())
    expect(fixture.finished()).toHaveLength(1)
    const lastPostcondition = fixture.query.mock.calls.findLastIndex(([sql]) => sql.includes("i.indisvalid AS valid") && sql.includes("c.relname=$2"))
    const receipt = fixture.query.mock.calls.findIndex(([sql]) => /UPDATE .*_prisma_migrations SET finished_at/.test(sql))
    expect(receipt).toBeGreaterThan(lastPostcondition)
    expect(fixture.release).toHaveBeenCalledOnce()
  })

  it("does not finish a no-job attempt when an existing index is invalid", async () => {
    const fixture = migrationPool({ invalidIndex: true })
    const response = await applyMigrations(fixture.pool, "compass_prod", "060_workspace_updates")

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("is not ready or has drifted") })
    expect(fixture.finished()).toHaveLength(0)
    expect(fixture.release).toHaveBeenCalledOnce()
  })

  it("waits and verifies returned jobs before completing the receipt", async () => {
    const fixture = migrationPool({ jobId: "synthetic-job", jobStatus: "completed" })
    const response = await applyMigrations(fixture.pool, "compass_prod", "060_workspace_updates")

    expect(await response.json()).not.toHaveProperty("error")
    expect(response.status).toBe(200)
    expect(fixture.query.mock.calls.filter(([sql]) => sql === "CALL sys.wait_for_job($1)")).toHaveLength(2)
    expect(fixture.query.mock.calls.filter(([sql]) => sql === "SELECT status FROM sys.jobs WHERE job_id = $1")).toHaveLength(2)
    expect(fixture.finished()).toHaveLength(1)
    expect(fixture.release).toHaveBeenCalledOnce()
  })

  it.each(["failed", "running", "cancelled", undefined])("does not finish when a returned job state is %s", async (jobStatus) => {
    const fixture = migrationPool({ jobId: "synthetic-job", jobStatus })
    const response = await applyMigrations(fixture.pool, "compass_prod", "060_workspace_updates")

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("did not complete successfully") })
    expect(fixture.finished()).toHaveLength(0)
    expect(fixture.release).toHaveBeenCalledOnce()
  })

  it("does not finish when waiting for a returned job throws", async () => {
    const fixture = migrationPool({ jobId: "synthetic-job", waitError: new Error("synthetic wait failure") })
    const response = await applyMigrations(fixture.pool, "compass_prod", "060_workspace_updates")

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: "synthetic wait failure" })
    expect(fixture.finished()).toHaveLength(0)
    expect(fixture.release).toHaveBeenCalledOnce()
  })
})
