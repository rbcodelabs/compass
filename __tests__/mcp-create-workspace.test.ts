/**
 * Unit tests for the create_workspace MCP tool.
 *
 * Strategy: mock @/lib/db so no real database is needed, then invoke the
 * tool handler by registering a fake McpServer that captures the callback
 * passed to server.registerTool.  We call the callback directly with
 * controlled inputs and assert on the returned text.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { runWithMcpActor } from "@/lib/mcp-authz"

// ── Prisma mock ─────────────────────────────────────────────────────────────

const mockPrisma = {
  organization: {
    findUnique: vi.fn(),
  },
  workspace: {
    findFirst: vi.fn(),
    create: vi.fn(),
  },
  organizationMember: {
    findMany: vi.fn(),
  },
  workspaceMember: {
    createMany: vi.fn(),
  },
}

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}))

// ── next/cache mock — asserts the newly created workspace invalidates the
// cached workspace list pages (dashboard + sidebar switcher) so it shows up
// without a hard reload. ─────────────────────────────────────────────────
const mockRevalidatePath = vi.fn()
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}))

// ── Fake McpServer that captures the last-registered tool callback ───────────

type ToolCallback = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>

const registeredTools: Record<string, ToolCallback> = {}

vi.mock("mcp-handler", () => ({
  createMcpHandler: (setup: (server: { registerTool: (name: string, meta: unknown, cb: ToolCallback) => void; registerResource: (...args: unknown[]) => void }) => void) => {
    // Run setup eagerly so all tools register into our capture object
    setup({
      registerTool(name, _meta, cb) {
        registeredTools[name] = cb
      },
      registerResource() {},
    })
    // Return a stub handler — we never call it in these tests
    return () => new Response("ok")
  },
}))

// ── Also mock mcp-auth so the module can be imported ────────────────────────

vi.mock("@/lib/mcp-auth", () => ({
  validateMcpAuth: vi.fn().mockResolvedValue({ valid: true }),
}))

// ── Import the route module so the side-effect runs and registers tools ──────
// This import must come AFTER all vi.mock() calls.
await import("@/app/api/mcp/route")

// ── Helpers ──────────────────────────────────────────────────────────────────

function getHandler(name: string): ToolCallback {
  const h = registeredTools[name]
  if (!h) throw new Error(`Tool "${name}" was not registered`)
  return ((args: Record<string, unknown>) => runWithMcpActor({ userId: null, purpose: "SERVICE" }, () => h(args))) as ToolCallback
}

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0].text
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("create_workspace MCP tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("happy path: creates workspace and returns id, name, slug, and URL path", async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({ id: "org-uuid-1", name: "RB Code Labs" })
    mockPrisma.workspace.findFirst.mockResolvedValue(null)
    mockPrisma.workspace.create.mockResolvedValue({
      id: "ws-uuid-1",
      name: "My Product",
      slug: "my-product",
    })
    mockPrisma.organizationMember.findMany.mockResolvedValue([
      { userId: "user-1", role: "OWNER" },
    ])
    mockPrisma.workspaceMember.createMany.mockResolvedValue({ count: 1 })

    const handler = getHandler("create_workspace")
    const result = await handler({ orgSlug: "rbcodelabs", name: "My Product", slug: "my-product" })
    const text = textOf(result)

    expect(text).toContain("Workspace created")
    expect(text).toContain("ws-uuid-1")
    expect(text).toContain("My Product")
    expect(text).toContain("my-product")
    expect(text).toContain("/rbcodelabs/my-product")

    // Verify the workspace was created with correct data
    expect(mockPrisma.workspace.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "org-uuid-1",
        name: "My Product",
        slug: "my-product",
      }),
    })

    // The seeded membership must carry a WorkspaceRole. The org member above
    // is an OWNER, which is not one.
    expect(mockPrisma.workspaceMember.createMany).toHaveBeenCalledWith({
      data: [{ workspaceId: "ws-uuid-1", userId: "user-1", role: "ADMIN" }],
      skipDuplicates: true,
    })
  })

  it("normalizes every org role when seeding workspace membership", async () => {
    // Regression test. WorkspaceRole is "ADMIN" | "MEMBER"; OrgRole adds
    // "OWNER". This handler used to copy the org role straight across, so an
    // org OWNER ended up with WorkspaceMember.role = "OWNER" — a value outside
    // the type — and was then denied by the strict ADMIN check in
    // resolveWorkspaceAdmin, locking them out of the workspace they had just
    // created. The original version of this test seeded an OWNER org member and
    // asserted nothing about the createMany payload, which is why it shipped.
    mockPrisma.organization.findUnique.mockResolvedValue({ id: "org-uuid-1", name: "RB Code Labs" })
    mockPrisma.workspace.findFirst.mockResolvedValue(null)
    mockPrisma.workspace.create.mockResolvedValue({ id: "ws-uuid-3", name: "Third", slug: "third" })
    mockPrisma.organizationMember.findMany.mockResolvedValue([
      { userId: "user-owner", role: "OWNER" },
      { userId: "user-admin", role: "ADMIN" },
      { userId: "user-member", role: "MEMBER" },
      { userId: "user-legacy", role: "owner" },
    ])
    mockPrisma.workspaceMember.createMany.mockResolvedValue({ count: 4 })

    const handler = getHandler("create_workspace")
    await handler({ orgSlug: "rbcodelabs", name: "Third", slug: "third" })

    expect(mockPrisma.workspaceMember.createMany).toHaveBeenCalledWith({
      data: [
        { workspaceId: "ws-uuid-3", userId: "user-owner", role: "ADMIN" },
        { workspaceId: "ws-uuid-3", userId: "user-admin", role: "ADMIN" },
        { workspaceId: "ws-uuid-3", userId: "user-member", role: "MEMBER" },
        { workspaceId: "ws-uuid-3", userId: "user-legacy", role: "ADMIN" },
      ],
      skipDuplicates: true,
    })

    const seeded = mockPrisma.workspaceMember.createMany.mock.calls[0][0].data as Array<{ role: string }>
    expect(seeded.map((d) => d.role)).not.toContain("OWNER")
  })

  it("revalidates the dashboard and root layout so the new workspace shows up without a hard reload", async () => {
    // Regression test for: newly created workspace does not appear in the
    // workspace list UI (soft-nav / client-side router cache serves the
    // stale pre-creation payload for /dashboard and the sidebar switcher).
    mockPrisma.organization.findUnique.mockResolvedValue({ id: "org-uuid-1", name: "RB Code Labs" })
    mockPrisma.workspace.findFirst.mockResolvedValue(null)
    mockPrisma.workspace.create.mockResolvedValue({
      id: "ws-uuid-2",
      name: "Second Product",
      slug: "second-product",
    })
    mockPrisma.organizationMember.findMany.mockResolvedValue([])

    const handler = getHandler("create_workspace")
    await handler({ orgSlug: "rbcodelabs", name: "Second Product", slug: "second-product" })

    expect(mockRevalidatePath).toHaveBeenCalledWith("/dashboard")
    expect(mockRevalidatePath).toHaveBeenCalledWith("/", "layout")
  })

  it("does not revalidate when workspace creation fails (org not found)", async () => {
    mockPrisma.organization.findUnique.mockResolvedValue(null)

    const handler = getHandler("create_workspace")
    await handler({ orgSlug: "nonexistent", name: "Foo", slug: "foo" })

    expect(mockRevalidatePath).not.toHaveBeenCalled()
  })

  it("returns an error when the org slug is not found", async () => {
    mockPrisma.organization.findUnique.mockResolvedValue(null)

    const handler = getHandler("create_workspace")
    const result = await handler({ orgSlug: "nonexistent", name: "Foo", slug: "foo" })
    const text = textOf(result)

    expect(text).toContain('No organization found with slug "nonexistent"')
    expect(mockPrisma.workspace.create).not.toHaveBeenCalled()
  })

  it("returns an error when a workspace with the same slug already exists", async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({ id: "org-uuid-1", name: "RB Code Labs" })
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "existing-ws" })

    const handler = getHandler("create_workspace")
    const result = await handler({ orgSlug: "rbcodelabs", name: "Duplicate", slug: "my-product" })
    const text = textOf(result)

    expect(text).toContain('slug "my-product" already exists')
    expect(mockPrisma.workspace.create).not.toHaveBeenCalled()
  })
})
