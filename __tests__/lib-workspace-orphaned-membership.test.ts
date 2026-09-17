/**
 * Regression test for lib/workspace.ts's getUserWorkspaces().
 *
 * Aurora DSQL runs with relationMode="prisma" (no database-level FK
 * constraints), so a WorkspaceMember row can outlive the Workspace or
 * Organization it points at — observed in production (Compass feedback
 * 496638f0-245a-464f-a2a5-18bf76460780): one such orphaned row made
 * `getUserWorkspaces` throw on `workspace.id` for a null `workspace`, and
 * because `app/[orgSlug]/[workspaceSlug]/layout.tsx` calls it unconditionally
 * for every workspace-scoped route, that one bad row 500'd the user's entire
 * authenticated surface — not just the dangling workspace.
 *
 * Prisma and next/headers aren't touched here — this is a pure DB-layer unit
 * test mocking @/lib/db, matching the existing pattern in
 * __tests__/portal-auth.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const mockWorkspaceMember = {
  findMany: vi.fn(),
}

const mockPrisma = {
  workspaceMember: mockWorkspaceMember,
}

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}))

import { getUserWorkspaces } from "@/lib/workspace"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("getUserWorkspaces", () => {
  it("returns every membership when all workspace/organization relations resolve", async () => {
    mockWorkspaceMember.findMany.mockResolvedValue([
      {
        id: "member-1",
        workspaceId: "ws-1",
        workspace: {
          id: "ws-1",
          name: "Alpha",
          slug: "alpha",
          organization: { slug: "org-1", name: "Org One" },
        },
      },
    ])

    const result = await getUserWorkspaces("user-1")

    expect(result).toEqual([
      { id: "ws-1", name: "Alpha", slug: "alpha", orgSlug: "org-1", orgName: "Org One" },
    ])
  })

  it("drops an orphaned membership (null workspace) instead of throwing", async () => {
    // Simulates a WorkspaceMember row whose Workspace was deleted without a
    // matching FK cascade (no DB-level constraint on DSQL) — Prisma resolves
    // the include to null rather than failing the query.
    mockWorkspaceMember.findMany.mockResolvedValue([
      { id: "member-orphan", workspaceId: "ws-deleted", workspace: null },
      {
        id: "member-2",
        workspaceId: "ws-2",
        workspace: {
          id: "ws-2",
          name: "Beta",
          slug: "beta",
          organization: { slug: "org-2", name: "Org Two" },
        },
      },
    ])

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const result = await expect(getUserWorkspaces("user-1")).resolves.toEqual([
      { id: "ws-2", name: "Beta", slug: "beta", orgSlug: "org-2", orgName: "Org Two" },
    ])

    // The orphan is logged, not silently dropped without a trace.
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("member-orphan"))

    errorSpy.mockRestore()
    return result
  })

  it("drops a membership whose workspace resolved but whose organization did not", async () => {
    // A rarer variant of the same class of bug: the Workspace row still
    // exists but its Organization was removed without cascading first.
    mockWorkspaceMember.findMany.mockResolvedValue([
      {
        id: "member-orphan-org",
        workspaceId: "ws-3",
        workspace: { id: "ws-3", name: "Gamma", slug: "gamma", organization: null },
      },
    ])

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    await expect(getUserWorkspaces("user-1")).resolves.toEqual([])

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("member-orphan-org"))
    errorSpy.mockRestore()
  })

  it("returns an empty array when every membership is orphaned, never throws", async () => {
    mockWorkspaceMember.findMany.mockResolvedValue([
      { id: "member-orphan-1", workspaceId: "ws-a", workspace: null },
      { id: "member-orphan-2", workspaceId: "ws-b", workspace: null },
    ])
    vi.spyOn(console, "error").mockImplementation(() => {})

    await expect(getUserWorkspaces("user-1")).resolves.toEqual([])
  })
})
