/**
 * Authorization tests for the inline get_opportunity MCP tool.
 *
 * Locks the INLINE-handler pattern of the per-user authz retrofit: an inline
 * tool reads the ambient actor via getMcpActor() and gates with
 * assertEntityAccess. Uses the capture harness (mock createMcpHandler to grab
 * the registered callbacks) and drives them inside runWithMcpActor(...) to
 * establish the acting identity — exactly as the real withMcpAuth boundary does.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { runWithMcpActor } from "@/lib/mcp-authz"

// ── Prisma mock ──────────────────────────────────────────────────────────────
const mockPrisma = {
  opportunity: { findUnique: vi.fn() },
  workspace: { findFirst: vi.fn() },
}
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

// ── Capture harness: grab each registered tool callback ──────────────────────
type ToolCallback = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>
const registeredTools: Record<string, ToolCallback> = {}
vi.mock("mcp-handler", () => ({
  createMcpHandler: (setup: (server: { registerTool: (n: string, m: unknown, cb: ToolCallback) => void }) => void) => {
    setup({ registerTool(name, _meta, cb) { registeredTools[name] = cb } })
    return () => new Response("ok")
  },
}))
vi.mock("@/lib/mcp-auth", () => ({ validateMcpAuth: vi.fn().mockResolvedValue({ valid: true, userId: "user-1" }) }))

await import("@/app/api/mcp/route")

const getHandler = (name: string): ToolCallback => {
  const h = registeredTools[name]
  if (!h) throw new Error(`Tool "${name}" was not registered`)
  return h
}
const textOf = (r: { content: Array<{ text: string }> }) => r.content[0].text

const OPP_ID = "opp-1"
const MEMBER = { userId: "user-1" }
const SERVICE = { userId: null }

beforeEach(() => {
  vi.clearAllMocks()
  // Superset return: satisfies both the authz resolver (workspaceId) and the
  // handler's own include-based fetch (title/status/solutions).
  mockPrisma.opportunity.findUnique.mockResolvedValue({
    id: OPP_ID,
    title: "Reduce churn",
    status: "EXPLORING",
    workspaceId: "ws-1",
    description: null,
    squad: null,
    linkedKeyResult: null,
    solutions: [],
  })
  mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" }) // member by default
})

describe("get_opportunity authorization", () => {
  it("allows a member and returns the opportunity detail", async () => {
    const handler = getHandler("get_opportunity")
    const result = await runWithMcpActor(MEMBER, () => handler({ opportunityId: OPP_ID }))
    expect(textOf(result)).toContain("Reduce churn")
    expect(mockPrisma.workspace.findFirst).toHaveBeenCalledWith({
      where: { id: "ws-1", members: { some: { userId: "user-1" } } },
      select: { id: true },
    })
  })

  it("denies a non-member (throws, surfaced as isError by the SDK)", async () => {
    mockPrisma.workspace.findFirst.mockResolvedValue(null) // not a member
    const handler = getHandler("get_opportunity")
    await expect(
      runWithMcpActor(MEMBER, () => handler({ opportunityId: OPP_ID }))
    ).rejects.toThrow(/not found or access denied/)
  })

  it("denies when the opportunity does not exist", async () => {
    mockPrisma.opportunity.findUnique.mockResolvedValue(null)
    const handler = getHandler("get_opportunity")
    await expect(
      runWithMcpActor(MEMBER, () => handler({ opportunityId: "nope" }))
    ).rejects.toThrow(/not found or access denied/)
  })

  it("service key bypasses the membership check", async () => {
    const handler = getHandler("get_opportunity")
    const result = await runWithMcpActor(SERVICE, () => handler({ opportunityId: OPP_ID }))
    expect(textOf(result)).toContain("Reduce churn")
    expect(mockPrisma.workspace.findFirst).not.toHaveBeenCalled()
  })
})
