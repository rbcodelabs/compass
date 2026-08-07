/**
 * Unit tests for the get_workspace_by_slug MCP tool.
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

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}))

// ── Fake McpServer that captures every registered tool callback ─────────────

type ToolCallback = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>

const registeredTools: Record<string, ToolCallback> = {}

vi.mock("mcp-handler", () => ({
  createMcpHandler: (setup: (server: { registerTool: (name: string, meta: unknown, cb: ToolCallback) => void }) => void) => {
    // Run setup eagerly so all tools register into our capture object
    setup({
      registerTool(name, _meta, cb) {
        registeredTools[name] = cb
      },
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
  return ((args: Record<string, unknown>) => runWithMcpActor({ userId: null }, () => h(args))) as ToolCallback
}

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0].text
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("get_workspace_by_slug MCP tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("happy path: resolves org slug + workspace slug to workspace id, name, slug, and URL", async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({ id: "org-uuid-1", name: "RB Code Labs" })
    mockPrisma.workspace.findFirst.mockResolvedValue({
      id: "ws-uuid-1",
      name: "Compass",
      slug: "compass",
      description: "Product discovery app",
    })

    const handler = getHandler("get_workspace_by_slug")
    const result = await handler({ orgSlug: "rbcodelabs", workspaceSlug: "compass" })
    const text = textOf(result)

    expect(text).toContain("Compass")
    expect(text).toContain("ws-uuid-1")
    expect(text).toContain("compass")
    expect(text).toContain("Product discovery app")
    expect(text).toContain("/rbcodelabs/compass")

    expect(mockPrisma.organization.findUnique).toHaveBeenCalledWith({
      where: { slug: "rbcodelabs" },
      select: { id: true, name: true },
    })
    expect(mockPrisma.workspace.findFirst).toHaveBeenCalledWith({
      where: { organizationId: "org-uuid-1", slug: "compass" },
      select: { id: true, name: true, slug: true, description: true },
    })
  })

  it("omits the description line when the workspace has none", async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({ id: "org-uuid-1", name: "RB Code Labs" })
    mockPrisma.workspace.findFirst.mockResolvedValue({
      id: "ws-uuid-2",
      name: "Compass",
      slug: "compass",
      description: null,
    })

    const handler = getHandler("get_workspace_by_slug")
    const result = await handler({ orgSlug: "rbcodelabs", workspaceSlug: "compass" })
    const text = textOf(result)

    expect(text).toContain("ws-uuid-2")
    expect(text).not.toContain("null")
  })

  it("returns an error when the org slug is not found", async () => {
    mockPrisma.organization.findUnique.mockResolvedValue(null)

    const handler = getHandler("get_workspace_by_slug")
    const result = await handler({ orgSlug: "nonexistent", workspaceSlug: "compass" })
    const text = textOf(result)

    expect(text).toContain('No organization found with slug "nonexistent"')
    expect(mockPrisma.workspace.findFirst).not.toHaveBeenCalled()
  })

  it("returns an error when the workspace slug is not found within a valid org", async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({ id: "org-uuid-1", name: "RB Code Labs" })
    mockPrisma.workspace.findFirst.mockResolvedValue(null)

    const handler = getHandler("get_workspace_by_slug")
    const result = await handler({ orgSlug: "rbcodelabs", workspaceSlug: "nonexistent" })
    const text = textOf(result)

    expect(text).toContain('No workspace found with slug "nonexistent"')
    expect(text).toContain("RB Code Labs")
  })

  it("scopes the workspace lookup to the resolved organization, not a global slug match", async () => {
    // Regression guard: workspace.slug is only unique per-org
    // (@@unique([organizationId, slug])), so the lookup must filter by
    // organizationId — never a bare findFirst({ where: { slug } }).
    mockPrisma.organization.findUnique.mockResolvedValue({ id: "org-uuid-1", name: "RB Code Labs" })
    mockPrisma.workspace.findFirst.mockResolvedValue({
      id: "ws-uuid-1",
      name: "Compass",
      slug: "compass",
      description: null,
    })

    const handler = getHandler("get_workspace_by_slug")
    await handler({ orgSlug: "rbcodelabs", workspaceSlug: "compass" })

    const whereArg = mockPrisma.workspace.findFirst.mock.calls[0][0].where
    expect(whereArg).toHaveProperty("organizationId", "org-uuid-1")
  })
})
