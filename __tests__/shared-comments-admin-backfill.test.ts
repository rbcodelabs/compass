import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PoolClient } from "pg"
import { runSharedCommentsBackfill } from "@/lib/shared-comments-backfill"

function invariantRow(overrides: Record<string, string> = {}) {
  return {
    orphaned_doc_comments: "0",
    orphaned_solution_comments: "0",
    missing_or_mismatched_doc_comments: "0",
    missing_or_mismatched_solution_comments: "0",
    missing_anchors: "0",
    missing_plans: "0",
    invalid_replies: "0",
    ...overrides,
  }
}

describe("runSharedCommentsBackfill", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test")
    vi.stubEnv("VERCEL_ENV", "production")
    vi.stubEnv("PGSCHEMA", "compass")
  })

  it("fails closed before writes when any legacy row is orphaned", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [invariantRow({ orphaned_doc_comments: "2" })], rowCount: 1 })
    const result = await runSharedCommentsBackfill({ query } as unknown as PoolClient, { operation: "backfill", batchSize: 500 })
    expect(query).toHaveBeenCalledTimes(1)
    expect(result.complete).toBe(false)
    expect(result.invariants.orphanedDocComments).toBe(2)
    expect(String(query.mock.calls[0][0])).toContain('"compass_prod".doc_comments')
  })

  it("executes one bounded idempotent batch and reports remaining invariants", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [invariantRow({ missing_or_mismatched_doc_comments: "1" })], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [invariantRow()], rowCount: 1 })
    const result = await runSharedCommentsBackfill({ query } as unknown as PoolClient, { operation: "backfill", batchSize: 25 })
    expect(result.complete).toBe(true)
    expect(result.processed).toEqual({ insertedDocComments: 1, insertedSolutionComments: 0, insertedAnchors: 1, insertedPlans: 0 })
    for (const call of query.mock.calls.slice(1, 5)) {
      expect(call[1]).toEqual([25])
      expect(String(call[0])).toContain("ON CONFLICT")
    }
  })

  it("validation is read-only and returns aggregate counts", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [invariantRow({ missing_plans: "3" })], rowCount: 1 })
    const result = await runSharedCommentsBackfill({ query } as unknown as PoolClient, { operation: "validate", batchSize: 500 })
    expect(query).toHaveBeenCalledTimes(1)
    expect(result.processed).toBeUndefined()
    expect(result.invariants.missingPlans).toBe(3)
  })
})
