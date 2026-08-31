import { describe, expect, it } from "vitest"
import { planDsqlWriteBatch } from "@/lib/dsql-backfill"

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
