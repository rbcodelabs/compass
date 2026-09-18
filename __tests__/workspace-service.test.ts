/**
 * Unit tests for createWorkspaceInOrg — the workspace-creation write shared by
 * the MCP `create_workspace` tool and the org-settings server action.
 *
 * Prisma is mocked entirely; no database.
 *
 * __tests__/mcp-create-workspace.test.ts covers the same behaviour *through*
 * the MCP handler and is deliberately left unmodified — together the two files
 * assert that the extraction changed nothing observable at the MCP boundary.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const mockPrisma = {
  organization: { findUnique: vi.fn() },
  workspace: { findFirst: vi.fn(), create: vi.fn() },
  organizationMember: { findMany: vi.fn() },
  workspaceMember: { createMany: vi.fn() },
}

vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

const mockRevalidatePath = vi.fn()
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}))

import { createWorkspaceInOrg } from "@/lib/workspace-service"

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.organization.findUnique.mockResolvedValue({ id: "org-1", name: "RB Code Labs" })
  mockPrisma.workspace.findFirst.mockResolvedValue(null)
  mockPrisma.workspace.create.mockResolvedValue({
    id: "ws-1",
    name: "My Product",
    slug: "my-product",
    description: null,
  })
  mockPrisma.organizationMember.findMany.mockResolvedValue([])
  mockPrisma.workspaceMember.createMany.mockResolvedValue({ count: 0 })
})

describe("createWorkspaceInOrg", () => {
  it("creates the workspace with trimmed name and description", async () => {
    const result = await createWorkspaceInOrg({
      orgSlug: "rbcodelabs",
      name: "  My Product  ",
      slug: "my-product",
      description: "  Everything product  ",
    })

    expect(result).toEqual({
      ok: true,
      workspace: { id: "ws-1", name: "My Product", slug: "my-product", description: null },
    })
    expect(mockPrisma.workspace.create).toHaveBeenCalledWith({
      data: {
        organizationId: "org-1",
        name: "My Product",
        slug: "my-product",
        description: "Everything product",
      },
    })
  })

  it("passes description through as undefined when omitted", async () => {
    await createWorkspaceInOrg({ orgSlug: "rbcodelabs", name: "My Product", slug: "my-product" })

    expect(mockPrisma.workspace.create).toHaveBeenCalledWith({
      data: {
        organizationId: "org-1",
        name: "My Product",
        slug: "my-product",
        description: undefined,
      },
    })
  })

  it("seeds membership for every org member with NORMALIZED workspace roles", async () => {
    // The bug this guards: OrgRole has OWNER, WorkspaceRole does not. Copying
    // the org role straight across wrote "OWNER" into WorkspaceMember.role,
    // which then failed resolveWorkspaceAdmin's strict ADMIN check and locked
    // the org owner out of the workspace they had just created. That is the
    // reason app/api/admin/repair-workspace-memberships/route.ts exists.
    mockPrisma.organizationMember.findMany.mockResolvedValue([
      { userId: "user-owner", role: "OWNER" },
      { userId: "user-admin", role: "ADMIN" },
      { userId: "user-member", role: "MEMBER" },
      { userId: "user-legacy", role: "owner" },
      { userId: "user-junk", role: "wat" },
    ])

    await createWorkspaceInOrg({ orgSlug: "rbcodelabs", name: "My Product", slug: "my-product" })

    expect(mockPrisma.organizationMember.findMany).toHaveBeenCalledWith({
      where: { organizationId: "org-1" },
      select: { userId: true, role: true },
    })
    expect(mockPrisma.workspaceMember.createMany).toHaveBeenCalledWith({
      data: [
        { workspaceId: "ws-1", userId: "user-owner", role: "ADMIN" },
        { workspaceId: "ws-1", userId: "user-admin", role: "ADMIN" },
        { workspaceId: "ws-1", userId: "user-member", role: "MEMBER" },
        { workspaceId: "ws-1", userId: "user-legacy", role: "ADMIN" },
        { workspaceId: "ws-1", userId: "user-junk", role: "MEMBER" },
      ],
      skipDuplicates: true,
    })

    const seeded = mockPrisma.workspaceMember.createMany.mock.calls[0][0].data as Array<{
      role: string
    }>
    expect(seeded.map((d) => d.role)).not.toContain("OWNER")
  })

  it("skips the membership write entirely when the org has no members", async () => {
    mockPrisma.organizationMember.findMany.mockResolvedValue([])

    const result = await createWorkspaceInOrg({
      orgSlug: "rbcodelabs",
      name: "My Product",
      slug: "my-product",
    })

    expect(result.ok).toBe(true)
    expect(mockPrisma.workspaceMember.createMany).not.toHaveBeenCalled()
  })

  it("revalidates /dashboard and the root layout on success", async () => {
    await createWorkspaceInOrg({ orgSlug: "rbcodelabs", name: "My Product", slug: "my-product" })

    expect(mockRevalidatePath).toHaveBeenCalledWith("/dashboard")
    expect(mockRevalidatePath).toHaveBeenCalledWith("/", "layout")
  })

  it("fails with ORG_NOT_FOUND when the org slug does not resolve", async () => {
    mockPrisma.organization.findUnique.mockResolvedValue(null)

    const result = await createWorkspaceInOrg({
      orgSlug: "nonexistent",
      name: "Foo",
      slug: "foo",
    })

    expect(result).toEqual({
      ok: false,
      code: "ORG_NOT_FOUND",
      error: 'No organization found with slug "nonexistent".',
    })
    expect(mockPrisma.workspace.create).not.toHaveBeenCalled()
    expect(mockRevalidatePath).not.toHaveBeenCalled()
  })

  it("fails with SLUG_TAKEN when a workspace already has that slug in the org", async () => {
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "existing-ws" })

    const result = await createWorkspaceInOrg({
      orgSlug: "rbcodelabs",
      name: "Duplicate",
      slug: "my-product",
    })

    expect(result).toEqual({
      ok: false,
      code: "SLUG_TAKEN",
      error: 'A workspace with slug "my-product" already exists in organization "RB Code Labs".',
    })
    // The uniqueness check is scoped to the org — a same-named workspace in a
    // different org must not collide.
    expect(mockPrisma.workspace.findFirst).toHaveBeenCalledWith({
      where: { organizationId: "org-1", slug: "my-product" },
      select: { id: true },
    })
    expect(mockPrisma.workspace.create).not.toHaveBeenCalled()
    expect(mockRevalidatePath).not.toHaveBeenCalled()
  })

  // ── Losing a create race ────────────────────────────────────────────────
  //
  // The findFirst above is a fast path for a friendly message, not the
  // enforcement boundary. `workspaces_organization_id_slug_key` (001_init) is,
  // and it is what fires when two admins submit the same slug at once. Before
  // this mapping the loser got an unhandled P2002 — a 500 with a digest —
  // instead of the sentence describing exactly what happened.

  it("maps a P2002 on the slug index onto SLUG_TAKEN", async () => {
    mockPrisma.workspace.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), {
        code: "P2002",
        meta: { target: ["organization_id", "slug"] },
      })
    )

    const result = await createWorkspaceInOrg({
      orgSlug: "rbcodelabs",
      name: "My Product",
      slug: "my-product",
    })

    expect(result).toEqual({
      ok: false,
      code: "SLUG_TAKEN",
      // Identical wording to the fast-path rejection — the user cannot tell
      // which of the two detected it, and should not have to.
      error: 'A workspace with slug "my-product" already exists in organization "RB Code Labs".',
    })
    // A failed create must not leave membership rows behind.
    expect(mockPrisma.workspaceMember.createMany).not.toHaveBeenCalled()
    expect(mockRevalidatePath).not.toHaveBeenCalled()
  })

  it("maps a P2002 with no meta.target onto SLUG_TAKEN", async () => {
    // Some driver/adapter combinations omit meta. Workspace's only other
    // unique index is its primary key, so a slug conflict is the sole
    // plausible cause and a correct message beats an unhandled 500.
    mockPrisma.workspace.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
    )

    const result = await createWorkspaceInOrg({
      orgSlug: "rbcodelabs",
      name: "My Product",
      slug: "my-product",
    })

    expect(result).toMatchObject({ ok: false, code: "SLUG_TAKEN" })
  })

  it("rethrows a P2002 that names some other column", async () => {
    // A primary-key collision means gen_random_uuid() repeated itself. That is
    // not a duplicate slug and must not be reported to the user as one.
    mockPrisma.workspace.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), {
        code: "P2002",
        meta: { target: ["id"] },
      })
    )

    await expect(
      createWorkspaceInOrg({ orgSlug: "rbcodelabs", name: "My Product", slug: "my-product" })
    ).rejects.toThrow("Unique constraint failed")
  })

  it("does not swallow a genuine fault — a failing write still throws", async () => {
    // Expected failures are returned as data; infrastructure faults must keep
    // throwing so they reach error monitoring with a digest.
    mockPrisma.workspace.create.mockRejectedValue(new Error("connection reset"))

    await expect(
      createWorkspaceInOrg({ orgSlug: "rbcodelabs", name: "My Product", slug: "my-product" })
    ).rejects.toThrow("connection reset")
  })
})
