import { beforeEach, describe, expect, it, vi } from "vitest"

vi.unmock("@/lib/feature-tables")

import { customFieldInheritanceTableExists, resetFeatureTablesCache } from "@/lib/feature-tables"

const prisma = { customFieldInheritanceRule: { findFirst: vi.fn() } }
const probe = () => customFieldInheritanceTableExists(prisma as never)

beforeEach(() => {
  vi.clearAllMocks()
  resetFeatureTablesCache()
})

describe("customFieldInheritanceTableExists", () => {
  it("reads a missing table (Prisma P2021) as absent, so code can ship before migration 113", async () => {
    prisma.customFieldInheritanceRule.findFirst.mockRejectedValue({ code: "P2021" })
    expect(await probe()).toBe(false)
    // Only a positive answer is cached: the feature comes alive once the migration lands.
    prisma.customFieldInheritanceRule.findFirst.mockResolvedValue(null)
    expect(await probe()).toBe(true)
  })

  it("caches a positive answer", async () => {
    prisma.customFieldInheritanceRule.findFirst.mockResolvedValue(null)
    await probe()
    await probe()
    expect(prisma.customFieldInheritanceRule.findFirst).toHaveBeenCalledTimes(1)
  })

  it("propagates any other database error instead of guessing", async () => {
    prisma.customFieldInheritanceRule.findFirst.mockRejectedValue(new Error("connection reset"))
    await expect(probe()).rejects.toThrow("connection reset")
  })
})
