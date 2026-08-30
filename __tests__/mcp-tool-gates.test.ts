/**
 * Authorization coverage for the MCP tool catalog.
 *
 * 1. COMPLETENESS — every tool actually registered in app/api/mcp/route.ts has
 *    an entry in TOOL_GATES. This is the build-time guarantee that no tool can
 *    ship without an authorization policy (the runtime guarantee is
 *    applyToolGate throwing for unmapped tools).
 * 2. ENFORCEMENT — applyToolGate short-circuits for the service key, denies
 *    unmapped tools for per-user callers, and wires representative tools to the
 *    right membership/role/landmine checks.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Prisma mock (for enforcement cases) ─────────────────────────────────────
const mockPrisma = {
  workspace: { findFirst: vi.fn() },
  workspaceMember: { findFirst: vi.fn() },
  organization: { findUnique: vi.fn() },
  organizationMember: { findFirst: vi.fn() },
  opportunity: { findUnique: vi.fn() },
  solution: { findUnique: vi.fn() },
  artifact: { findUnique: vi.fn() },
  feedbackItem: { findUnique: vi.fn() },
}
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

// ── Capture harness: enumerate the tools route.ts actually registers ────────
const registeredTools: Record<string, unknown> = {}
vi.mock("mcp-handler", () => ({
  createMcpHandler: (setup: (s: { registerTool: (n: string, m: unknown, cb: unknown) => void }) => void) => {
    setup({ registerTool(name, _m, cb) { registeredTools[name] = cb } })
    return () => new Response("ok")
  },
}))
vi.mock("@/lib/mcp-auth", () => ({ validateMcpAuth: vi.fn().mockResolvedValue({ valid: true, userId: "u1" }) }))

await import("@/app/api/mcp/route")
import { TOOL_GATES, applyToolGate } from "@/lib/mcp-tool-gates"
import { runWithMcpActor } from "@/lib/mcp-authz"

const MEMBER = { userId: "user-1" }
const SERVICE = { userId: null }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const callTool = (name: string, actor: { userId: string | null }, args: any) =>
  runWithMcpActor(actor, () => (registeredTools[name] as (a: unknown) => Promise<unknown>)(args))

beforeEach(() => vi.clearAllMocks())

describe("TOOL_GATES completeness", () => {
  it("registers at least the full known catalog", () => {
    // Guards against a silent drop in registration/capture.
    expect(Object.keys(registeredTools).length).toBeGreaterThanOrEqual(78)
  })

  it("every registered MCP tool has an authorization policy", () => {
    const missing = Object.keys(registeredTools).filter((name) => !(name in TOOL_GATES))
    expect(missing).toEqual([])
  })

  it("has no policy entries for tools that are not registered (no dead policies)", () => {
    const dead = Object.keys(TOOL_GATES).filter((name) => !(name in registeredTools))
    expect(dead).toEqual([])
  })
})

describe("applyToolGate", () => {
  it("short-circuits (no gate, no query) for the service key", async () => {
    await expect(applyToolGate("get_opportunity", SERVICE, { opportunityId: "x" })).resolves.toBeUndefined()
    expect(mockPrisma.opportunity.findUnique).not.toHaveBeenCalled()
  })

  it("denies an unmapped tool for a per-user caller (fail-closed)", async () => {
    await expect(applyToolGate("totally_new_tool", MEMBER, {})).rejects.toThrow(/No authorization policy/)
  })

  it("get_opportunity: denies a non-member", async () => {
    mockPrisma.opportunity.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.workspace.findFirst.mockResolvedValue(null) // not a member
    await expect(applyToolGate("get_opportunity", MEMBER, { opportunityId: "opp-1" })).rejects.toThrow(
      /not found or access denied/
    )
  })

  it("get_opportunity: allows a member", async () => {
    mockPrisma.opportunity.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
    await expect(applyToolGate("get_opportunity", MEMBER, { opportunityId: "opp-1" })).resolves.toBeUndefined()
  })

  it("create_workspace: requires org admin (plain member denied)", async () => {
    mockPrisma.organizationMember.findFirst.mockResolvedValue({ organizationId: "org-1", role: "MEMBER" })
    await expect(applyToolGate("create_workspace", MEMBER, { orgSlug: "acme" })).rejects.toThrow(
      /organization admin required/
    )
  })

  it("promote_to_roadmap: rejects a workspaceId that doesn't own the solution (landmine)", async () => {
    // Solution belongs to ws-1, but the caller passes ws-2.
    mockPrisma.solution.findUnique.mockResolvedValue({ opportunity: { workspaceId: "ws-1" } })
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" }) // member of the real workspace
    await expect(
      applyToolGate("promote_to_roadmap", MEMBER, { solutionId: "sol-1", workspaceId: "ws-2" })
    ).rejects.toThrow(/does not belong to workspace/)
  })

  it("link_artifact_to_solution: rejects cross-workspace targets", async () => {
    mockPrisma.artifact.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.solution.findUnique.mockResolvedValue({ opportunity: { workspaceId: "ws-2" } })
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
    await expect(applyToolGate("link_artifact_to_solution", MEMBER, {
      artifactId: "art-1", solutionId: "sol-1", workspaceId: "ws-1",
    })).rejects.toThrow(/does not belong to workspace/)
  })

  it("prepare_feedback_attachment_upload denies a non-member", async () => {
    mockPrisma.workspace.findFirst.mockResolvedValue(null)
    await expect(applyToolGate("prepare_feedback_attachment_upload", MEMBER, { workspaceId: "ws-1" }))
      .rejects.toThrow(/not found or access denied/)
  })

  it.each(["update_feedback", "add_feedback_attachment"])("%s denies access to another workspace's feedback", async (tool) => {
    mockPrisma.feedbackItem.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.workspace.findFirst.mockResolvedValue(null)
    await expect(applyToolGate(tool, MEMBER, { feedbackId: "feedback-1" }))
      .rejects.toThrow(/not found or access denied/)
  })
})

// End-to-end through the ACTUAL route wiring: the register() wrapper must run
// the gate before the handler. Drives a captured, gated handler under a
// per-user actor scope — no direct applyToolGate call.
describe("register() wrapper enforces gates end-to-end", () => {
  it("denies a non-member calling get_opportunity (gate runs before the handler)", async () => {
    mockPrisma.opportunity.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.workspace.findFirst.mockResolvedValue(null) // not a member
    await expect(callTool("get_opportunity", MEMBER, { opportunityId: "opp-1" })).rejects.toThrow(
      /not found or access denied/
    )
    // Handler's own fetch (include-based) is never reached — gate threw first.
    expect(mockPrisma.opportunity.findUnique).toHaveBeenCalledTimes(1)
  })

  it("allows a member and reaches the handler", async () => {
    mockPrisma.opportunity.findUnique.mockResolvedValue({
      workspaceId: "ws-1",
      id: "opp-1",
      title: "Reduce churn",
      status: "EXPLORING",
      description: null,
      squad: null,
      linkedKeyResult: null,
      solutions: [],
    })
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
    const result = (await callTool("get_opportunity", MEMBER, { opportunityId: "opp-1" })) as {
      content: { text: string }[]
    }
    expect(result.content[0].text).toContain("Reduce churn")
  })
})
