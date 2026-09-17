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
} from "@/lib/workspace"

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
