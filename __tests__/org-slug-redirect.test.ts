import { describe, it, expect, vi, beforeEach } from "vitest"

const mockRedirectRow = { findUnique: vi.fn() }
const mockOrganization = { findUnique: vi.fn() }
vi.mock("@/lib/db", () => ({
  default: vi.fn(() => ({ organizationSlugRedirect: mockRedirectRow, organization: mockOrganization })),
}))

import { lookupCurrentOrgSlug, retiredOrgSlugRedirectTarget } from "@/lib/org-slug-redirect"

beforeEach(() => {
  vi.resetAllMocks()
})

describe("lookupCurrentOrgSlug", () => {
  it("is a single read for a slug with no history (the common request)", async () => {
    mockRedirectRow.findUnique.mockResolvedValue(null)
    expect(await lookupCurrentOrgSlug("live-org")).toBeNull()
    expect(mockRedirectRow.findUnique).toHaveBeenCalledTimes(1)
    expect(mockOrganization.findUnique).not.toHaveBeenCalled()
  })

  it("resolves a retired slug to the organization's CURRENT slug (so a rename chain a -> b -> c lands on c)", async () => {
    mockRedirectRow.findUnique.mockResolvedValue({ organizationId: "org-1" })
    mockOrganization.findUnique.mockResolvedValue({ slug: "c" })
    expect(await lookupCurrentOrgSlug("a")).toBe("c")
    expect(mockOrganization.findUnique).toHaveBeenCalledWith({ where: { id: "org-1" }, select: { slug: true } })
  })

  it("returns null when the owning organization no longer exists", async () => {
    mockRedirectRow.findUnique.mockResolvedValue({ organizationId: "gone" })
    mockOrganization.findUnique.mockResolvedValue(null)
    expect(await lookupCurrentOrgSlug("a")).toBeNull()
  })
})

describe("retiredOrgSlugRedirectTarget", () => {
  it("returns the redirect path for a retired slug", async () => {
    mockRedirectRow.findUnique.mockResolvedValue({ organizationId: "org-1" })
    mockOrganization.findUnique.mockResolvedValue({ slug: "new-co" })
    expect(await retiredOrgSlugRedirectTarget("/old-co/ws/okrs", "?x=1")).toBe("/new-co/ws/okrs?x=1")
  })

  it("does not touch the database for non-org paths", async () => {
    expect(await retiredOrgSlugRedirectTarget("/api/mcp", "")).toBeNull()
    expect(await retiredOrgSlugRedirectTarget("/login", "")).toBeNull()
    expect(mockRedirectRow.findUnique).not.toHaveBeenCalled()
  })

  it("fails open when the lookup throws, so a database error cannot take every page down", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    mockRedirectRow.findUnique.mockRejectedValue(new Error("connection reset"))
    expect(await retiredOrgSlugRedirectTarget("/acme/ws/okrs", "")).toBeNull()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
