import { beforeEach, describe, expect, it, vi } from "vitest"

vi.unmock("@/lib/feature-tables")

import { customFieldInheritanceTableExists, readIfInheritanceTableExists, resetFeatureTablesCache } from "@/lib/feature-tables"

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

describe("readIfInheritanceTableExists", () => {
  it("returns undefined without reading when the table is absent", async () => {
    prisma.customFieldInheritanceRule.findFirst.mockRejectedValue({ code: "P2021" })
    const read = vi.fn(async () => ["rule"])
    expect(await readIfInheritanceTableExists(prisma as never, read)).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
  })

  it("returns what the read produced when the table exists", async () => {
    prisma.customFieldInheritanceRule.findFirst.mockResolvedValue(null)
    expect(await readIfInheritanceTableExists(prisma as never, async () => ["rule"])).toEqual(["rule"])
  })

  it("reads a table dropped after a positive probe as absent, and forgets the stale positive", async () => {
    // A long-lived server cached "exists", then the table went away (migration rolled back, restored database, a test dropping it).
    prisma.customFieldInheritanceRule.findFirst.mockResolvedValue(null)
    expect(await probe()).toBe(true)

    expect(await readIfInheritanceTableExists(prisma as never, async () => { throw { code: "P2021" } })).toBeUndefined()

    // The next probe asks the database again instead of trusting the stale positive, so recovery needs no restart either.
    prisma.customFieldInheritanceRule.findFirst.mockRejectedValue({ code: "P2021" })
    expect(await probe()).toBe(false)
  })

  it("propagates any other read error", async () => {
    prisma.customFieldInheritanceRule.findFirst.mockResolvedValue(null)
    await expect(readIfInheritanceTableExists(prisma as never, async () => { throw new Error("connection reset") })).rejects.toThrow("connection reset")
  })
})
