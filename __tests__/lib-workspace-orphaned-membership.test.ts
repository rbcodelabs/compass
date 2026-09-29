/**
 * Regression test for lib/workspace.ts's getUserWorkspaces().
 *
 * Aurora DSQL runs with relationMode="prisma" (no database-level FK
 * constraints), so rows can outlive the rows they point at — observed in
 * production (Compass feedback 496638f0-245a-464f-a2a5-18bf76460780): one
 * orphaned row made `getUserWorkspaces` throw for a null relation, and
 * because `app/[orgSlug]/[workspaceSlug]/layout.tsx` calls it unconditionally
 * for every workspace-scoped route, that one bad row 500'd the user's entire
 * authenticated surface — not just the dangling workspace.
 *
 * ── Note on shape ─────────────────────────────────────────────────────────
 * This file originally mocked `workspaceMember.findMany`, because
 * getUserWorkspaces walked the join table with a two-level include.
 * It now queries the `workspace` table directly with the membership expressed
 * as a relation *filter*, so the mock target changed accordingly.
 *
 * That change also splits the original bug in two, and only one half is still
 * a guard:
 *
 *   - "WorkspaceMember pointing at a deleted Workspace" is no longer
 *     reachable. Rows come from the workspace table itself, so a dangling
 *     membership matches nothing and is excluded by the query rather than by
 *     a null check. The case is asserted below as a query-shape assertion
 *     instead of a return-value one — deleting it outright would lose the
 *     record of why it stopped being possible.
 *   - "Workspace pointing at a deleted Organization" is unchanged and still
 *     needs the runtime guard, because Prisma types the relation as
 *     non-nullable while resolving it to null.
 *
 * Prisma and next/headers aren't touched here — this is a pure DB-layer unit
 * test mocking @/lib/db, matching the existing pattern in
 * __tests__/portal-auth.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const mockWorkspace = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
}

const mockOrganizationMember = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
}

const mockPrisma = {
  workspace: mockWorkspace,
  organizationMember: mockOrganizationMember,
}

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}))

import { getUserWorkspaces, getWorkspace } from "@/lib/workspace"

beforeEach(() => {
  vi.clearAllMocks()
  // Default: no org-wide read-only fallback in play. Individual tests below
  // override these to exercise that path explicitly.
  mockOrganizationMember.findFirst.mockResolvedValue(null)
  mockOrganizationMember.findMany.mockResolvedValue([])
})

describe("getWorkspace", () => {
  it("resolves a slug deterministically by ordering on createdAt", async () => {
    // `@@unique([organizationId, slug])` — the real index
    // `workspaces_organization_id_slug_key`, created by 001_init — means this
    // findFirst can only match one row. The orderBy is what keeps the failure
    // mode *diagnosable* if that invariant ever lapses: an unordered findFirst
    // would resolve /{org}/{slug} to a different workspace between requests,
    // so writes would appear and disappear rather than erroring.
    mockWorkspace.findFirst.mockResolvedValue(null)

    await getWorkspace("org-1", "alpha", "user-1")

    expect(mockWorkspace.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: "asc" } })
    )
  })

  it("still scopes the lookup to org slug, workspace slug, and membership", async () => {
    mockWorkspace.findFirst.mockResolvedValue(null)

    await getWorkspace("org-2", "beta", "user-2")

    expect(mockWorkspace.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          slug: "beta",
          organization: { slug: "org-2" },
          members: { some: { userId: "user-2" } },
        },
      })
    )
  })

  it("tags a real WorkspaceMember row as isReadOnly: false", async () => {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      organizationId: "org-1",
      organization: { id: "org-1" },
    })

    const workspace = await getWorkspace("org-1", "alpha", "user-1")

    expect(workspace?.isReadOnly).toBe(false)
  })

  describe("org-wide read-only fallback", () => {
    it("resolves the workspace read-only when there is no membership but the org flag is on", async () => {
      mockWorkspace.findFirst
        .mockResolvedValueOnce(null) // membership-scoped lookup fails
        .mockResolvedValueOnce({
          id: "ws-1",
          organizationId: "org-1",
          organization: { id: "org-1" },
        }) // read-only fallback lookup succeeds
      mockOrganizationMember.findFirst.mockResolvedValue({ id: "orgmember-1" })

      const workspace = await getWorkspace("org-1", "alpha", "user-1")

      expect(workspace).toMatchObject({ id: "ws-1", isReadOnly: true })
    })

    it("returns null when the org flag is off (fallback lookup matches nothing)", async () => {
      mockWorkspace.findFirst.mockResolvedValue(null)

      const workspace = await getWorkspace("org-1", "alpha", "user-1")

      expect(workspace).toBeNull()
    })

    it("returns null when the org-flagged workspace exists but the caller has no OrganizationMember row", async () => {
      mockWorkspace.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: "ws-1",
          organizationId: "org-1",
          organization: { id: "org-1" },
        })
      mockOrganizationMember.findFirst.mockResolvedValue(null)

      const workspace = await getWorkspace("org-1", "alpha", "user-1")

      expect(workspace).toBeNull()
    })
  })
})

describe("getUserWorkspaces", () => {
  it("returns every workspace when all organization relations resolve", async () => {
    mockWorkspace.findMany.mockResolvedValue([
      {
        id: "ws-1",
        name: "Alpha",
        slug: "alpha",
        organization: { slug: "org-1", name: "Org One" },
      },
    ])

    const result = await getUserWorkspaces("user-1")

    expect(result).toEqual([
      { id: "ws-1", name: "Alpha", slug: "alpha", orgSlug: "org-1", orgName: "Org One", isReadOnly: false },
    ])
  })

  it("excludes a membership pointing at a deleted workspace via the query, not a guard", async () => {
    // The original form of this case fed a `{ workspace: null }` membership
    // row in and asserted it was dropped. That row can no longer exist in the
    // result set: the query selects workspaces and filters on the membership
    // relation, so a WorkspaceMember whose Workspace is gone matches nothing.
    // Assert the shape that makes it true.
    mockWorkspace.findMany.mockResolvedValue([])

    await expect(getUserWorkspaces("user-1")).resolves.toEqual([])

    expect(mockWorkspace.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { members: { some: { userId: "user-1" } } },
      })
    )
  })

  it("drops a workspace whose organization did not resolve", async () => {
    // The Workspace row still exists but its Organization was removed without
    // cascading first. Prisma types `organization` as non-nullable and
    // resolves it to null here, so an unguarded dereference would throw for
    // every workspace in the result, not just this one.
    mockWorkspace.findMany.mockResolvedValue([
      { id: "ws-3", name: "Gamma", slug: "gamma", organization: null },
      {
        id: "ws-2",
        name: "Beta",
        slug: "beta",
        organization: { slug: "org-2", name: "Org Two" },
      },
    ])

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    // The healthy sibling still comes back — one orphan must not take out the
    // whole authenticated surface, which was the production failure.
    await expect(getUserWorkspaces("user-1")).resolves.toEqual([
      { id: "ws-2", name: "Beta", slug: "beta", orgSlug: "org-2", orgName: "Org Two", isReadOnly: false },
    ])

    // The orphan is logged, not silently dropped without a trace.
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("ws-3"))

    errorSpy.mockRestore()
  })

  it("returns an empty array when every workspace is orphaned, never throws", async () => {
    mockWorkspace.findMany.mockResolvedValue([
      { id: "ws-a", name: "A", slug: "a", organization: null },
      { id: "ws-b", name: "B", slug: "b", organization: null },
    ])
    vi.spyOn(console, "error").mockImplementation(() => {})

    await expect(getUserWorkspaces("user-1")).resolves.toEqual([])
  })

  describe("org-wide read-only fallback", () => {
    it("unions in workspaces from a read-only org, tagged isReadOnly: true", async () => {
      // No real memberships at all.
      mockWorkspace.findMany.mockResolvedValueOnce([])
      mockOrganizationMember.findMany.mockResolvedValue([
        { organizationId: "org-9", organization: { slug: "org-9", name: "Org Nine" } },
      ])
      // Second findMany call: every workspace owned by the read-only org.
      mockWorkspace.findMany.mockResolvedValueOnce([
        { id: "ws-9", name: "Nine Workspace", slug: "nine", organizationId: "org-9" },
      ])

      const result = await getUserWorkspaces("user-1")

      expect(result).toEqual([
        { id: "ws-9", name: "Nine Workspace", slug: "nine", orgSlug: "org-9", orgName: "Org Nine", isReadOnly: true },
      ])
    })

    it("never downgrades a workspace the user is a real member of, even if the org flag is also on", async () => {
      mockWorkspace.findMany.mockResolvedValueOnce([
        { id: "ws-9", name: "Nine Workspace", slug: "nine", organization: { slug: "org-9", name: "Org Nine" } },
      ])
      mockOrganizationMember.findMany.mockResolvedValue([
        { organizationId: "org-9", organization: { slug: "org-9", name: "Org Nine" } },
      ])
      // The read-only org owns two workspaces; the user is a real member of
      // one of them (ws-9, already in the first result set above).
      mockWorkspace.findMany.mockResolvedValueOnce([
        { id: "ws-9", name: "Nine Workspace", slug: "nine", organizationId: "org-9" },
        { id: "ws-10", name: "Ten Workspace", slug: "ten", organizationId: "org-9" },
      ])

      const result = await getUserWorkspaces("user-1")

      expect(result).toEqual([
        { id: "ws-9", name: "Nine Workspace", slug: "nine", orgSlug: "org-9", orgName: "Org Nine", isReadOnly: false },
        { id: "ws-10", name: "Ten Workspace", slug: "ten", orgSlug: "org-9", orgName: "Org Nine", isReadOnly: true },
      ])
    })

    it("skips the second query entirely when no org grants read-only access", async () => {
      mockWorkspace.findMany.mockResolvedValueOnce([])
      mockOrganizationMember.findMany.mockResolvedValue([])

      await getUserWorkspaces("user-1")

      expect(mockWorkspace.findMany).toHaveBeenCalledTimes(1)
    })
  })
})
