import { describe, expect, it, vi } from "vitest"
import { loadCustomFieldValuesForObjects } from "@/lib/custom-field-values-batch"

describe("loadCustomFieldValuesForObjects", () => {
  it("returns a map of objectId to value for the given field and objects", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { objectId: "item-1", value: "payments" },
      { objectId: "item-2", value: "growth" },
    ])
    const prisma = { customFieldValue: { findMany } }

    const result = await loadCustomFieldValuesForObjects(prisma, {
      fieldId: "field-1",
      objectIds: ["item-1", "item-2", "item-3"],
    })

    expect(findMany).toHaveBeenCalledWith({
      where: { fieldId: "field-1", objectId: { in: ["item-1", "item-2", "item-3"] } },
      select: { objectId: true, value: true },
    })
    expect(result.get("item-1")).toBe("payments")
    expect(result.get("item-2")).toBe("growth")
    expect(result.has("item-3")).toBe(false)
  })

  it("returns an empty map and skips the query entirely when there are no object ids", async () => {
    const findMany = vi.fn()
    const prisma = { customFieldValue: { findMany } }

    const result = await loadCustomFieldValuesForObjects(prisma, { fieldId: "field-1", objectIds: [] })

    expect(result.size).toBe(0)
    expect(findMany).not.toHaveBeenCalled()
  })

  it("keeps the last row's value when duplicate objectIds are somehow returned", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { objectId: "item-1", value: "old" },
      { objectId: "item-1", value: "new" },
    ])
    const prisma = { customFieldValue: { findMany } }

    const result = await loadCustomFieldValuesForObjects(prisma, { fieldId: "field-1", objectIds: ["item-1"] })

    expect(result.get("item-1")).toBe("new")
  })
})
