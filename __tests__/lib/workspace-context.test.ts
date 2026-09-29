import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Behavior and shape tests for the shared workspace resolver.
 *
 * Deliberately NOT gated on a database, unlike
 * __tests__/workspace-request-dedupe.integration.test.ts. That file proves the
 * request-memoization statement counts, but it is env-gated and therefore
 * skipped in a normal `pnpm test` run — so the guarantees that must hold on
 * every CI run (the membership predicate, the SSO-secret exclusion, and the
 * redirect-vs-notFound split) live here instead.
 *
 * React's `cache()` is a no-op passthrough under vitest's resolve conditions,
 * which is fine here: these assertions are about behavior, not dedupe.
 */

const findFirst = vi.hoisted(() => vi.fn())
const orgFindFirst = vi.hoisted(() => vi.fn())
vi.mock("@/lib/db", () => ({
  default: () => ({
    workspace: { findFirst },
    organizationMember: { findFirst: orgFindFirst },
  }),
}))

const authState = vi.hoisted(() => ({ userId: null as string | null }))
vi.mock("@/auth", () => ({
  auth: async () =>
    authState.userId
      ? { user: { id: authState.userId, name: "Test", email: "t@example.com", image: null } }
      : null,
}))

const redirect = vi.hoisted(() => vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) }))
const notFound = vi.hoisted(() => vi.fn(() => { throw new Error("NEXT_NOT_FOUND") }))
vi.mock("next/navigation", () => ({ redirect, notFound }))

import {
  getWorkspaceContext,
  requireWorkspaceContext,
  requireWorkspaceContextOrThrow,
  WORKSPACE_SUMMARY_SELECT,
  assertWorkspaceWritable,
  resolveWorkspaceAccess,
} from "@/lib/workspace-context"

const WORKSPACE = {
  id: "ws-1",
  name: "Core",
  slug: "core",
  organizationId: "org-1",
  feedbackEnabled: true,
  roadmapPublic: false,
  portalAuthRequired: false,
  brandingPaletteId: null,
  brandingPrimaryHex: null,
  brandingFontPresetId: null,
  brandingFontFamily: null,
  brandingLogoUrl: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  authState.userId = "user-1"
  findFirst.mockResolvedValue(WORKSPACE)
  orgFindFirst.mockResolvedValue({ role: "OWNER" })
})

describe("getWorkspaceContext", () => {
  it("returns unauthenticated without querying when there is no session", async () => {
    authState.userId = null
    const ctx = await getWorkspaceContext("acme", "core")
    expect(ctx.status).toBe("unauthenticated")
    expect(findFirst).not.toHaveBeenCalled()
    expect(orgFindFirst).not.toHaveBeenCalled()
  })

  it("returns not-found when the workspace does not resolve", async () => {
    findFirst.mockResolvedValue(null)
    const ctx = await getWorkspaceContext("acme", "core")
    expect(ctx.status).toBe("not-found")
  })

  it("scopes the lookup to the caller's membership", async () => {
    await getWorkspaceContext("acme", "core")
    // The regression guard for the exact failure mode discovery/layout.tsx
    // represented: a workspace lookup that forgets the membership predicate
    // and leans on some caller upstream having checked.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          slug: "core",
          organization: { slug: "acme" },
          members: { some: { userId: "user-1" } },
        }),
      })
    )
  })

  it("never selects SSO secret material", () => {
    const keys = Object.keys(WORKSPACE_SUMMARY_SELECT)
    expect(keys).not.toContain("ssoSecretEncrypted")
    expect(keys).not.toContain("ssoEnabled")
    expect(keys).not.toContain("ssoSecretUpdatedAt")
    // ...but must keep every branding column, which resolveWorkspaceBranding needs.
    for (const field of [
      "brandingPaletteId",
      "brandingPrimaryHex",
      "brandingFontPresetId",
      "brandingFontFamily",
      "brandingLogoUrl",
    ]) {
      expect(keys).toContain(field)
    }
  })

  it.each([
    ["OWNER", true],
    ["ADMIN", true],
    ["owner", true],
    ["admin", true],
    ["MEMBER", false],
    [null, false],
  ])("normalizes org role %s to isOrgAdmin=%s", async (role, expected) => {
    orgFindFirst.mockResolvedValue(role === null ? null : { role })
    const ctx = await getWorkspaceContext("acme", "core")
    expect(ctx.status === "ok" && ctx.isOrgAdmin).toBe(expected)
  })

  it("marks a real WorkspaceMember row as isReadOnly: false", async () => {
    const ctx = await getWorkspaceContext("acme", "core")
    expect(ctx.status === "ok" && ctx.isReadOnly).toBe(false)
  })

  describe("org-wide read-only fallback", () => {
    it("resolves a read-only context when there is no membership but the org flag is on", async () => {
      orgFindFirst.mockResolvedValue({ role: "MEMBER" })
      // First call is the membership-scoped lookup (fails); second call is the
      // read-only fallback lookup scoped to organization.memberWorkspaceReadOnlyAccess.
      findFirst.mockImplementation(async ({ where }: { where: { members?: unknown } }) => {
        if (where.members) return null
        return WORKSPACE
      })

      const ctx = await getWorkspaceContext("acme", "core")
      expect(ctx.status).toBe("ok")
      if (ctx.status !== "ok") throw new Error("unreachable")
      expect(ctx.isReadOnly).toBe(true)
      expect(ctx.workspace.id).toBe("ws-1")
      expect(ctx.orgRole).toBe("MEMBER")
    })

    it("stays not-found when there is no membership and the org flag is off", async () => {
      orgFindFirst.mockResolvedValue({ role: "MEMBER" })
      // Both the membership lookup and the read-only fallback lookup fail --
      // simulates memberWorkspaceReadOnlyAccess being off, so the fallback
      // where-clause matches nothing.
      findFirst.mockResolvedValue(null)

      const ctx = await getWorkspaceContext("acme", "core")
      expect(ctx.status).toBe("not-found")
    })

    it("never attempts the fallback when the caller isn't an OrganizationMember of this org at all", async () => {
      orgFindFirst.mockResolvedValue(null)
      findFirst.mockResolvedValue(null)

      const ctx = await getWorkspaceContext("acme", "core")
      expect(ctx.status).toBe("not-found")
      // Only the membership-scoped lookup should run -- no org membership
      // means there is nothing for the flag to grant.
      expect(findFirst).toHaveBeenCalledTimes(1)
    })
  })
})

describe("assertWorkspaceWritable", () => {
  it("is a no-op for a writable (non-read-only) context", () => {
    expect(() => assertWorkspaceWritable({ isReadOnly: false })).not.toThrow()
  })

  it("throws for a read-only context", () => {
    expect(() => assertWorkspaceWritable({ isReadOnly: true })).toThrow("read-only")
  })
})

describe("resolveWorkspaceAccess", () => {
  it("returns the workspace id and isReadOnly: false for a real member", async () => {
    findFirst.mockResolvedValueOnce({ id: "ws-1" })
    const access = await resolveWorkspaceAccess("acme", "core", "user-1")
    expect(access).toEqual({ workspaceId: "ws-1", isReadOnly: false })
  })

  it("returns isReadOnly: true when the org flag grants fallback access", async () => {
    findFirst
      .mockResolvedValueOnce(null) // membership lookup fails
      .mockResolvedValueOnce({ id: "ws-1" }) // read-only fallback lookup succeeds
    orgFindFirst.mockResolvedValueOnce({ id: "orgmember-1" })

    const access = await resolveWorkspaceAccess("acme", "core", "user-1")
    expect(access).toEqual({ workspaceId: "ws-1", isReadOnly: true })
  })

  it("returns null when neither membership nor the read-only fallback resolves", async () => {
    findFirst.mockResolvedValue(null)
    orgFindFirst.mockResolvedValueOnce(null)

    const access = await resolveWorkspaceAccess("acme", "core", "user-1")
    expect(access).toBeNull()
  })

  it("returns null when the workspace is flagged read-only but the caller isn't an org member", async () => {
    findFirst
      .mockResolvedValueOnce(null) // membership lookup fails
      .mockResolvedValueOnce({ id: "ws-1" }) // the org-flagged workspace does exist
    orgFindFirst.mockResolvedValueOnce(null) // but caller has no OrganizationMember row

    const access = await resolveWorkspaceAccess("acme", "core", "user-1")
    expect(access).toBeNull()
  })
})

describe("control flow wrappers", () => {
  it("redirects the signed-out caller", async () => {
    authState.userId = null
    await expect(requireWorkspaceContext("acme", "core")).rejects.toThrow("NEXT_REDIRECT:/login")
    expect(redirect).toHaveBeenCalledWith("/login")
  })

  it("404s a non-member", async () => {
    findFirst.mockResolvedValue(null)
    await expect(requireWorkspaceContext("acme", "core")).rejects.toThrow("NEXT_NOT_FOUND")
    expect(notFound).toHaveBeenCalled()
  })

  it("throws PermissionError messages for server actions instead of redirecting", async () => {
    authState.userId = null
    await expect(requireWorkspaceContextOrThrow("acme", "core")).rejects.toThrow("Unauthorized")
    expect(redirect).not.toHaveBeenCalled()

    authState.userId = "user-1"
    findFirst.mockResolvedValue(null)
    await expect(requireWorkspaceContextOrThrow("acme", "core")).rejects.toThrow("Workspace not found")
    expect(notFound).not.toHaveBeenCalled()
  })

  it("returns the resolved context on the happy path", async () => {
    const ctx = await requireWorkspaceContext("acme", "core")
    expect(ctx.workspace.id).toBe("ws-1")
    expect(ctx.userId).toBe("user-1")
    expect(redirect).not.toHaveBeenCalled()
    expect(notFound).not.toHaveBeenCalled()
  })
})
