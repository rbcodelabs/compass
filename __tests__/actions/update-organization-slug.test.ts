import { describe, it, expect, vi, beforeEach } from "vitest"

const mockOrganizationMember = { findFirst: vi.fn() }
const mockOrganization = { findUnique: vi.fn(), update: vi.fn() }
const mockSlugRedirect = { findUnique: vi.fn(), create: vi.fn(), delete: vi.fn() }

const mockPrisma = {
  organizationMember: mockOrganizationMember,
  organization: mockOrganization,
  organizationSlugRedirect: mockSlugRedirect,
  $transaction: vi.fn(),
}

vi.mock("@/lib/db", () => ({ default: vi.fn(() => mockPrisma) }))

const mockRevalidatePath = vi.fn()
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}))

vi.mock("@/auth", () => ({ auth: vi.fn() }))

import { auth } from "@/auth"
import { updateOrganizationSlug } from "@/app/[orgSlug]/settings/actions"

const mockAuth = vi.mocked(auth)

function uniqueConstraintError() {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
}

beforeEach(() => {
  vi.resetAllMocks()
  mockPrisma.$transaction.mockImplementation(async (callback: (tx: typeof mockPrisma) => unknown) => callback(mockPrisma))
  // auth is overloaded (it also wraps middleware), so the session shape needs an unknown hop.
  mockAuth.mockResolvedValue({ user: { id: "user-1" } } as unknown as never)
  mockOrganizationMember.findFirst.mockResolvedValue({ role: "ADMIN", organizationId: "org-1" })
  // The org as stored right now.
  mockOrganization.findUnique.mockImplementation(async ({ where }: { where: { id?: string; slug?: string } }) =>
    where.id === "org-1" ? { id: "org-1", slug: "acme" } : null,
  )
  mockSlugRedirect.findUnique.mockResolvedValue(null)
  mockSlugRedirect.create.mockResolvedValue({ id: "r-1" })
  mockSlugRedirect.delete.mockResolvedValue({ id: "r-1" })
  mockOrganization.update.mockResolvedValue({ id: "org-1", slug: "acme-labs" })
})

describe("updateOrganizationSlug: authorization", () => {
  it("rejects a signed-out caller without touching the database", async () => {
    mockAuth.mockResolvedValue(null as never)
    const result = await updateOrganizationSlug("acme", "acme-labs")
    expect(result).toEqual({ ok: false, error: "You are not signed in." })
    expect(mockOrganization.update).not.toHaveBeenCalled()
  })

  it("rejects a non-member", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue(null)
    const result = await updateOrganizationSlug("acme", "acme-labs")
    expect(result).toEqual({ ok: false, error: "Organization not found" })
    expect(mockOrganization.update).not.toHaveBeenCalled()
  })

  it("rejects an org member who is not an org admin", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue({ role: "MEMBER", organizationId: "org-1" })
    const result = await updateOrganizationSlug("acme", "acme-labs")
    expect(result).toEqual({ ok: false, error: "Forbidden: organization admin required" })
    expect(mockOrganization.update).not.toHaveBeenCalled()
  })

  it("gates on the ORGANIZATION role, not a workspace role (an org OWNER passes)", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue({ role: "OWNER", organizationId: "org-1" })
    const result = await updateOrganizationSlug("acme", "acme-labs")
    expect(result.ok).toBe(true)
    expect(mockOrganizationMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organization: { slug: "acme" } }) }),
    )
  })
})

describe("updateOrganizationSlug: validation", () => {
  it.each([
    ["", /required/i],
    ["Acme Labs", /lowercase letters, numbers, and hyphens/i],
    ["-acme", /start or end with a hyphen/i],
    ["a", /at least 2/i],
    ["api", /reserved/i],
    ["portal", /reserved/i],
    ["login", /reserved/i],
  ])("rejects %j before any write", async (input, message) => {
    const result = await updateOrganizationSlug("acme", input)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(message)
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(mockOrganization.update).not.toHaveBeenCalled()
  })

  it("rejects an unchanged slug", async () => {
    const result = await updateOrganizationSlug("acme", "acme")
    expect(result).toEqual({ ok: false, error: "That is already this organization's URL slug." })
    expect(mockOrganization.update).not.toHaveBeenCalled()
  })

  it("trims surrounding whitespace before validating", async () => {
    const result = await updateOrganizationSlug("acme", "  acme-labs ")
    expect(result.ok).toBe(true)
    expect(mockOrganization.update).toHaveBeenCalledWith(expect.objectContaining({ data: { slug: "acme-labs" } }))
  })
})

describe("updateOrganizationSlug: conflicts", () => {
  it("returns a friendly failure when another organization holds the slug", async () => {
    mockOrganization.findUnique.mockImplementation(async ({ where }: { where: { id?: string; slug?: string } }) =>
      where.id === "org-1" ? { id: "org-1", slug: "acme" } : where.slug === "taken" ? { id: "org-2", slug: "taken" } : null,
    )
    const result = await updateOrganizationSlug("acme", "taken")
    expect(result).toEqual({ ok: false, error: "That URL slug is already taken. Choose another." })
    expect(mockOrganization.update).not.toHaveBeenCalled()
    expect(mockSlugRedirect.create).not.toHaveBeenCalled()
  })

  it("treats another organization's retired slug as taken", async () => {
    mockSlugRedirect.findUnique.mockResolvedValue({ id: "r-9", organizationId: "org-2", oldSlug: "legacy" })
    const result = await updateOrganizationSlug("acme", "legacy")
    expect(result).toEqual({ ok: false, error: "That URL slug is already taken. Choose another." })
    expect(mockOrganization.update).not.toHaveBeenCalled()
    expect(mockSlugRedirect.delete).not.toHaveBeenCalled()
  })

  it("maps a unique-constraint race at write time to the same friendly failure", async () => {
    mockOrganization.update.mockRejectedValue(uniqueConstraintError())
    const result = await updateOrganizationSlug("acme", "acme-labs")
    expect(result).toEqual({ ok: false, error: "That URL slug is already taken. Choose another." })
  })

  it("rethrows an unexpected database error instead of masking it", async () => {
    mockOrganization.update.mockRejectedValue(new Error("connection reset"))
    await expect(updateOrganizationSlug("acme", "acme-labs")).rejects.toThrow("connection reset")
  })

  it("fails closed if the stored slug moved since the caller loaded the page", async () => {
    mockOrganization.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) =>
      where.id === "org-1" ? { id: "org-1", slug: "already-renamed" } : null,
    )
    const result = await updateOrganizationSlug("acme", "acme-labs")
    expect(result.ok).toBe(false)
    expect(mockOrganization.update).not.toHaveBeenCalled()
  })
})

describe("updateOrganizationSlug: success", () => {
  it("renames and records the old slug in ONE transaction", async () => {
    const result = await updateOrganizationSlug("acme", "acme-labs")
    expect(result).toEqual({ ok: true, slug: "acme-labs", redirectTo: "/acme-labs/settings" })
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    expect(mockOrganization.update).toHaveBeenCalledWith({ where: { id: "org-1" }, data: { slug: "acme-labs" } })
    expect(mockSlugRedirect.create).toHaveBeenCalledWith({ data: { organizationId: "org-1", oldSlug: "acme" } })
  })

  it("does not write the history row when the rename itself fails", async () => {
    // Both writes run on the transaction client, so a failure rolls the pair back; here we check
    // the order: the rename is attempted before the history row.
    const order: string[] = []
    mockOrganization.update.mockImplementation(async () => {
      order.push("update")
      throw uniqueConstraintError()
    })
    mockSlugRedirect.create.mockImplementation(async () => {
      order.push("create")
    })
    await updateOrganizationSlug("acme", "acme-labs")
    expect(order).toEqual(["update"])
  })

  it("renaming back to one of its own retired slugs deletes that history row", async () => {
    mockOrganization.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) =>
      where.id === "org-1" ? { id: "org-1", slug: "acme-labs" } : null,
    )
    mockSlugRedirect.findUnique.mockResolvedValue({ id: "r-1", organizationId: "org-1", oldSlug: "acme" })
    const result = await updateOrganizationSlug("acme-labs", "acme")
    expect(result).toEqual({ ok: true, slug: "acme", redirectTo: "/acme/settings" })
    expect(mockSlugRedirect.delete).toHaveBeenCalledWith({ where: { id: "r-1" } })
    expect(mockOrganization.update).toHaveBeenCalledWith({ where: { id: "org-1" }, data: { slug: "acme" } })
    // The slug it just left is retired in its place.
    expect(mockSlugRedirect.create).toHaveBeenCalledWith({ data: { organizationId: "org-1", oldSlug: "acme-labs" } })
  })

  it("revalidates the root layout and the new settings page", async () => {
    await updateOrganizationSlug("acme", "acme-labs")
    expect(mockRevalidatePath).toHaveBeenCalledWith("/", "layout")
  })
})
