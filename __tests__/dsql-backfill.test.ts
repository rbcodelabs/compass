import type { PoolClient } from "pg"
import { describe, expect, it, vi } from "vitest"
import {
  backfillRoadmapCommitmentProvenance,
  planDsqlWriteBatch,
} from "@/lib/dsql-backfill"

describe("planDsqlWriteBatch", () => {
  it("bounds a batch by row count", () => {
    const rows = Array.from({ length: 4 }, (_, index) => ({ id: `id-${index}`, estimatedBytes: 10 }))
    expect(planDsqlWriteBatch(rows, { maxRows: 3, maxBytes: 100 }).map((row) => row.id)).toEqual(["id-0", "id-1", "id-2"])
  })

  it("bounds a batch by conservative source-row bytes", () => {
    const rows = [{ id: "a", estimatedBytes: 60 }, { id: "b", estimatedBytes: 50 }, { id: "c", estimatedBytes: 1 }]
    expect(planDsqlWriteBatch(rows, { maxRows: 3, maxBytes: 100 }).map((row) => row.id)).toEqual(["a"])
  })

  it("fails closed when one row exceeds the write limit", () => {
    expect(() => planDsqlWriteBatch([{ id: "large", estimatedBytes: 101 }], { maxRows: 3, maxBytes: 100 }))
      .toThrow("exceeds Aurora DSQL's transaction byte limit")
  })
})

describe("backfillRoadmapCommitmentProvenance", () => {
  it.each(["not-a-number", "9007199254740992", "-1", "Infinity"])(
    "fails closed before writing when estimated bytes are unsafe: %s",
    async (estimatedBytes) => {
      const query = vi.fn().mockResolvedValueOnce({
        rows: [{ id: "00000000-0000-4000-8000-000000000039", estimated_bytes: estimatedBytes }],
      })
      const client = { query } as unknown as PoolClient

      await expect(backfillRoadmapCommitmentProvenance(client, "compass_preview", []))
        .rejects.toThrow("exceeds Aurora DSQL's transaction byte limit")
      expect(query).toHaveBeenCalledTimes(1)
    },
  )
})
