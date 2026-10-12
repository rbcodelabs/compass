import { describe, it, expect, vi, beforeEach } from "vitest"

const mockOrganizationMember = { findFirst: vi.fn() }
const mockOrganization = { findUnique: vi.fn(), update: vi.fn() }

const mockPrisma = {
  organizationMember: mockOrganizationMember,
  organization: mockOrganization,
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
  // auth is overloaded (it also wraps middleware), so the session shape needs an unknown hop.
  mockAuth.mockResolvedValue({ user: { id: "user-1" } } as unknown as never)
  mockOrganizationMember.findFirst.mockResolvedValue({ role: "ADMIN", organizationId: "org-1" })
  // The org as stored right now.
  mockOrganization.findUnique.mockImplementation(async ({ where }: { where: { id?: string; slug?: string } }) =>
    where.id === "org-1" ? { id: "org-1", slug: "acme" } : null,
  )
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

})

describe("updateOrganizationSlug: success", () => {
  it("renames the org and returns the new settings URL", async () => {
    const result = await updateOrganizationSlug("acme", "acme-labs")
    expect(result).toEqual({ ok: true, slug: "acme-labs", redirectTo: "/acme-labs/settings" })
    expect(mockOrganization.update).toHaveBeenCalledWith({ where: { id: "org-1" }, data: { slug: "acme-labs" } })
  })

  it("keeps no history: nothing but the organization row is written", async () => {
    await updateOrganizationSlug("acme", "acme-labs")
    expect(mockOrganization.update).toHaveBeenCalledTimes(1)
    expect(Object.keys(mockPrisma).sort()).toEqual(["organization", "organizationMember"])
  })

  it("a slug another org used to have is simply free (uniqueness is against current orgs only)", async () => {
    const result = await updateOrganizationSlug("acme", "formerly-someone-elses")
    expect(result.ok).toBe(true)
  })

  it("revalidates the root layout", async () => {
    await updateOrganizationSlug("acme", "acme-labs")
    expect(mockRevalidatePath).toHaveBeenCalledWith("/", "layout")
  })
})
