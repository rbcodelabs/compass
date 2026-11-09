import { beforeEach, describe, expect, it, vi } from "vitest"
import { setFeatureTables } from "./helpers/modules"

const m = vi.hoisted(() => ({ late: vi.fn() }))
vi.mock("@/lib/custom-field-inheritance", () => ({ applyInheritanceRules: vi.fn(), applyInheritanceForSourceValue: m.late }))

import { isClearingValue, writeCustomFieldValue } from "@/lib/custom-field-value-write"

const prisma = {
  customFieldValue: { upsert: vi.fn(), deleteMany: vi.fn() },
  $transaction: vi.fn(),
}
const base = { workspaceId: "ws-1", objectId: "obj-1", fieldId: "field-1" }

beforeEach(() => {
  vi.clearAllMocks()
  setFeatureTables({ inheritance: true })
  prisma.$transaction.mockImplementation((fn: (db: typeof prisma) => unknown) => fn(prisma))
  m.late.mockResolvedValue({ applied: [{ itemId: "item-1", fieldId: "f-partner" }], skippedByCap: 0 })
})

describe("writeCustomFieldValue (the single value-write funnel)", () => {
  it.each(["OPPORTUNITY", "SOLUTION"] as const)("sets a %s value and then runs the late-source hook in the same transaction", async (objectType) => {
    const result = await writeCustomFieldValue(prisma as never, { ...base, objectType, value: "acme" })

    expect(prisma.customFieldValue.upsert).toHaveBeenCalledWith({
      where: { fieldId_objectId: { fieldId: "field-1", objectId: "obj-1" } },
      create: { fieldId: "field-1", objectId: "obj-1", value: "acme" },
      update: { value: "acme", updatedAt: expect.any(Date) },
    })
    expect(m.late).toHaveBeenCalledWith(prisma, { workspaceId: "ws-1", sourceObjectType: objectType, sourceId: "obj-1", fieldId: "field-1" })
    expect(m.late.mock.invocationCallOrder[0]).toBeGreaterThan(prisma.customFieldValue.upsert.mock.invocationCallOrder[0])
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ cleared: false, inheritedItems: 1 })
  })

  it.each([null, "", []])("clearing (%j) deletes the row and never touches inheritance targets", async (value) => {
    const result = await writeCustomFieldValue(prisma as never, { ...base, objectType: "OPPORTUNITY", value })

    expect(prisma.customFieldValue.deleteMany).toHaveBeenCalledWith({ where: { fieldId: "field-1", objectId: "obj-1" } })
    expect(prisma.customFieldValue.upsert).not.toHaveBeenCalled()
    expect(m.late).not.toHaveBeenCalled()
    expect(result).toEqual({ cleared: true, inheritedItems: 0 })
  })

  it("keeps an explicit false / 0 as a value (not a clear)", async () => {
    expect(isClearingValue(false)).toBe(false)
    expect(isClearingValue(0)).toBe(false)
    await writeCustomFieldValue(prisma as never, { ...base, objectType: "OPPORTUNITY", value: false })
    expect(prisma.customFieldValue.upsert).toHaveBeenCalled()
  })

  it.each(["ROADMAP_ITEM", "TASK", "EXPERIMENT", "OBJECTIVE", "KEY_RESULT"] as const)("a %s value is a plain write: no transaction, no hook", async (objectType) => {
    await writeCustomFieldValue(prisma as never, { ...base, objectType, value: "x" })

    expect(prisma.customFieldValue.upsert).toHaveBeenCalledTimes(1)
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(m.late).not.toHaveBeenCalled()
  })

  it("is a plain write while the rules table does not exist (code may ship before the migration)", async () => {
    setFeatureTables({ inheritance: false })
    await writeCustomFieldValue(prisma as never, { ...base, objectType: "OPPORTUNITY", value: "acme" })

    expect(prisma.customFieldValue.upsert).toHaveBeenCalledTimes(1)
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(m.late).not.toHaveBeenCalled()
  })

  it("a failing hook fails the whole write (the transaction rolls the value back)", async () => {
    m.late.mockRejectedValue(new Error("hook failed"))
    await expect(writeCustomFieldValue(prisma as never, { ...base, objectType: "OPPORTUNITY", value: "acme" })).rejects.toThrow("hook failed")
  })
})
