import { expect, it } from "vitest"
import { deleteScopedImportRows } from "@/lib/workspace-export/leaf-first"

it("bounds each rollback mutation even when one parent owns hundreds of child rows", async () => {
  let remaining = 427
  const batchSizes: number[] = []
  const where = { parentId: { in: ["parent"] } }
  await deleteScopedImportRows(where, async args => {
    expect(args.where).toEqual(where)
    expect(args.limit).toBeLessThanOrEqual(100)
    const count = Math.min(args.limit, remaining)
    remaining -= count
    batchSizes.push(count)
    return { count }
  })
  expect(remaining).toBe(0)
  expect(batchSizes.length).toBeGreaterThan(4)
})
