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
  opportunity: { findUnique: vi.fn(), update: vi.fn() },
  solution: { findUnique: vi.fn(), update: vi.fn() },
  artifact: { findUnique: vi.fn() },
  feedbackItem: { findUnique: vi.fn() },
  doc: { findUnique: vi.fn() },
  reviewRequest: { findUnique: vi.fn() },
  decisionRecord: { findUnique: vi.fn() },
  researchStudy: { findUnique: vi.fn() },
  agent: { findFirst: vi.fn() },
  agentWorkspaceGrant: { findMany: vi.fn() },
  task: { findUnique: vi.fn() },
  customFieldDefinition: { findMany: vi.fn(), findUnique: vi.fn() },
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
import { AGENT_TOOL_POLICY, RESEARCH_TOOL_ALLOWLIST, TOOL_GATES, applyToolGate } from "@/lib/mcp-tool-gates"
import { runWithMcpActor } from "@/lib/mcp-authz"

const MEMBER = { userId: "user-1" }
const SERVICE = { userId: null, purpose: "SERVICE" as const }
const RESEARCH = { userId: "user-1", purpose: "RESEARCH" as const, scopeWorkspaceId: "ws-1" }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const callTool = (name: string, actor: { userId: string | null }, args: any) =>
  runWithMcpActor(actor, () => (registeredTools[name] as (a: unknown) => Promise<unknown>)(args))

beforeEach(() => vi.clearAllMocks())

describe("Decision Artifact mutation boundaries", () => {
  for (const tool of ["link_artifact_to_decision", "unlink_artifact_from_decision"]) {
    it(`${tool} is classified as an agent write`, () => {
      expect(AGENT_TOOL_POLICY[tool]).toBe("WRITE")
    })
    for (const foreign of ["artifact", "reviewRequest"] as const) {
      it(`${tool} rejects a foreign ${foreign}`, async () => {
        mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
        mockPrisma.artifact.findUnique.mockResolvedValue({ workspaceId: foreign === "artifact" ? "ws-2" : "ws-1" })
        mockPrisma.reviewRequest.findUnique.mockResolvedValue({ workspaceId: foreign === "reviewRequest" ? "ws-2" : "ws-1" })
        await expect(applyToolGate(tool, MEMBER, { workspaceId: "ws-1", artifactId: "art-1", requestId: "req-1" })).rejects.toThrow(/does not belong to workspace/)
      })
    }
    it(`${tool} denies a non-member`, async () => {
      mockPrisma.workspace.findFirst.mockResolvedValue(null)
      await expect(applyToolGate(tool, MEMBER, { workspaceId: "ws-1", artifactId: "art-1", requestId: "req-1" })).rejects.toThrow(/not found or access denied/)
    })
    it(`${tool} excludes read-only agent grants`, async () => {
      vi.stubEnv("COMPASS_AGENTS_ENABLED", "1")
      try {
        mockPrisma.agent.findFirst.mockResolvedValue({ id: "agent" })
        mockPrisma.agentWorkspaceGrant.findMany.mockResolvedValue([])
        mockPrisma.workspace.findFirst.mockResolvedValue(null)
        await expect(applyToolGate(tool, { userId: "user-1", purpose: "AGENT", agentId: "agent" }, { workspaceId: "ws-1", artifactId: "art-1", requestId: "req-1" })).rejects.toThrow(/not found or access denied/)
        expect(mockPrisma.agentWorkspaceGrant.findMany).toHaveBeenCalledWith({ where: { agentId: "agent", revokedAt: null, access: "WRITE" }, select: { workspaceId: true } })
      } finally { vi.unstubAllEnvs() }
    })
  }
})

describe("apply_recorded_decision service-actor access", () => {
  // The tool's own registered description says "Service actors may apply but
  // cannot take decisions." — this asserts the policy actually matches that
  // contract (regression guard for the human-only-list mistake).
  it("is classified as an agent write, not human-only", () => {
    expect(AGENT_TOOL_POLICY.apply_recorded_decision).toBe("WRITE")
  })
  it("lets an agent identity reach the decisionRecord workspace gate", async () => {
    mockPrisma.decisionRecord.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    vi.stubEnv("COMPASS_AGENTS_ENABLED", "1")
    try {
      mockPrisma.agent.findFirst.mockResolvedValue({ id: "agent" })
      mockPrisma.agentWorkspaceGrant.findMany.mockResolvedValue([{ workspaceId: "ws-1" }])
      mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
      await expect(applyToolGate("apply_recorded_decision", { userId: "user-1", purpose: "AGENT", agentId: "agent" }, { decisionId: "decision-1" })).resolves.toBeUndefined()
    } finally { vi.unstubAllEnvs() }
  })
})

describe("research study agent policy", () => {
  // Reviewed 2026-09-13: reads return only publicMetadata() — no transcripts,
  // participant identities or credentials — and authoring is an ordinary
  // workspace write. Link issuance and activation mint or expose live
  // participant access, so they stay human-only. Locks that boundary.
  it.each(["list_research_studies", "get_research_study", "list_research_sessions", "get_research_session"])("%s is classified as an agent read", (tool) => {
    expect(AGENT_TOOL_POLICY[tool]).toBe("READ")
  })
  // ADR-0012 step 3: transcript reads are study-scoped like every other
  // study tool, so they cannot be pointed at a study in another workspace.
  it.each(["list_research_sessions", "get_research_session"])("%s is gated on the declared workspace owning the study", (tool) => {
    expect(TOOL_GATES[tool]).toBeDefined()
  })
  it.each(["generate_research_guide", "create_research_study", "update_research_study"])("%s is classified as an agent write", (tool) => {
    expect(AGENT_TOOL_POLICY[tool]).toBe("WRITE")
  })
  it.each(["activate_research_study", "close_research_study", "archive_research_study", "issue_research_link", "rotate_research_link", "revoke_research_links"])("%s stays human-only", (tool) => {
    expect(AGENT_TOOL_POLICY[tool]).toBe("DENY")
  })

  it("lets an agent identity reach the workspace gate for list_research_studies", async () => {
    vi.stubEnv("COMPASS_AGENTS_ENABLED", "1")
    try {
      mockPrisma.agent.findFirst.mockResolvedValue({ id: "agent" })
      mockPrisma.agentWorkspaceGrant.findMany.mockResolvedValue([{ workspaceId: "ws-1" }])
      mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
      await expect(applyToolGate("list_research_studies", { userId: "user-1", purpose: "AGENT", agentId: "agent" }, { workspaceId: "ws-1" })).resolves.toBeUndefined()
      // READ policy widens the grant filter; it does not bypass workspace scoping.
      expect(mockPrisma.agentWorkspaceGrant.findMany).toHaveBeenCalledWith({ where: { agentId: "agent", revokedAt: null, access: { in: ["READ", "WRITE"] } }, select: { workspaceId: true } })
    } finally { vi.unstubAllEnvs() }
  })

  it("list_research_studies still denies an agent without a grant on the workspace", async () => {
    vi.stubEnv("COMPASS_AGENTS_ENABLED", "1")
    try {
      mockPrisma.agent.findFirst.mockResolvedValue({ id: "agent" })
      mockPrisma.agentWorkspaceGrant.findMany.mockResolvedValue([])
      mockPrisma.workspace.findFirst.mockResolvedValue(null)
      await expect(applyToolGate("list_research_studies", { userId: "user-1", purpose: "AGENT", agentId: "agent" }, { workspaceId: "ws-1" })).rejects.toThrow(/not found or access denied/)
    } finally { vi.unstubAllEnvs() }
  })

  it("issue_research_link still requires a human identity", async () => {
    await expect(applyToolGate("issue_research_link", { userId: "user-1", purpose: "AGENT", agentId: "agent" }, { workspaceId: "ws-1", studyId: "study-1" }))
      .rejects.toThrow("Tool requires a human identity: issue_research_link")
  })
})

describe("TOOL_GATES completeness", () => {
  it("classifies every registered tool for agent access", () => {
    expect(Object.keys(registeredTools).filter(name => !AGENT_TOOL_POLICY[name])).toEqual([])
  })
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
  it.each(["get_research_study", "update_research_study", "activate_research_study", "close_research_study", "archive_research_study", "issue_research_link", "rotate_research_link", "revoke_research_links", "list_research_sessions", "get_research_session"])("%s rejects a study outside the declared workspace", async tool => {
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "declared" })
    mockPrisma.researchStudy.findUnique.mockResolvedValue({ workspaceId: "foreign" })
    await expect(applyToolGate(tool, MEMBER, { workspaceId: "declared", studyId: "study", sessionId: "session" })).rejects.toThrow(/does not belong to workspace declared/)
  })
  it.each(["list_research_sessions", "get_research_session"])("%s denies a non-member of the declared workspace", async tool => {
    mockPrisma.researchStudy.findUnique.mockResolvedValue({ workspaceId: "declared" })
    mockPrisma.workspace.findFirst.mockResolvedValue(null)
    await expect(applyToolGate(tool, MEMBER, { workspaceId: "declared", studyId: "study", sessionId: "session" })).rejects.toThrow(/not found or access denied/)
  })
  it("gives public research credentials no internal workspace tools", () => {
    expect([...RESEARCH_TOOL_ALLOWLIST]).toEqual([])
  })

  it("short-circuits (no gate, no query) for the service key", async () => {
    await expect(applyToolGate("get_opportunity", SERVICE, { opportunityId: "x" })).resolves.toBeUndefined()
    expect(mockPrisma.opportunity.findUnique).not.toHaveBeenCalled()
  })

  it("denies an unmapped tool for a per-user caller (fail-closed)", async () => {
    await expect(applyToolGate("totally_new_tool", MEMBER, {})).rejects.toThrow(/No authorization policy/)
  })

  it("research credentials deny both read and write workspace tools", async () => {
    await expect(applyToolGate("list_feedback", RESEARCH, { workspaceId: "ws-1" })).rejects.toThrow(
      /not available to research interviews/
    )
    await expect(applyToolGate("create_feedback", RESEARCH, { workspaceId: "ws-1" })).rejects.toThrow(
      /not available to research interviews/
    )
  })

  it.each(["list_solutions", "list_assumptions", "list_release_runs"])(
    "%s denies discovery outside the caller's workspace membership",
    async (tool) => {
      mockPrisma.workspace.findFirst.mockResolvedValue(null)
      await expect(applyToolGate(tool, MEMBER, { workspaceId: "ws-1" })).rejects.toThrow(
        /not found or access denied/,
      )
    },
  )

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

  it("update_opportunity: denies a cross-workspace caller before the handler writes", async () => {
    mockPrisma.opportunity.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.workspace.findFirst.mockResolvedValue(null)

    await expect(callTool("update_opportunity", MEMBER, {
      opportunityId: "opp-1",
      title: "New title",
    })).rejects.toThrow(/not found or access denied/)

    expect(mockPrisma.opportunity.findUnique).toHaveBeenCalledTimes(1)
    expect(mockPrisma.opportunity.update).not.toHaveBeenCalled()
  })

  it("update_solution_status preserves the solution workspace boundary", async () => {
    mockPrisma.solution.findUnique.mockResolvedValue({ opportunity: { workspaceId: "ws-1" } })
    mockPrisma.workspace.findFirst.mockResolvedValue(null)

    await expect(
      applyToolGate("update_solution_status", MEMBER, { solutionId: "sol-1", status: "SHIPPED" })
    ).rejects.toThrow(/not found or access denied/)
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

  it("request_decision rejects a linked entity from another workspace", async () => {
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
    mockPrisma.doc.findUnique.mockResolvedValue({ workspaceId: "ws-2" })
    await expect(applyToolGate("request_decision", MEMBER, { workspaceId: "ws-1", subjectType: "DOC", subjectId: "doc-1" }))
      .rejects.toThrow(/does not belong to workspace/)
  })

  it("get_decision requires the request to belong to the declared workspace", async () => {
    mockPrisma.reviewRequest.findUnique.mockResolvedValue({ workspaceId: "ws-2" })
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-2" })
    await expect(applyToolGate("get_decision", MEMBER, { workspaceId: "ws-1", requestId: "request-1" }))
      .rejects.toThrow(/does not belong to workspace/)
  })

  it.each(["update_feedback", "add_feedback_attachment"])("%s denies access to another workspace's feedback", async (tool) => {
    mockPrisma.feedbackItem.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.workspace.findFirst.mockResolvedValue(null)
    await expect(applyToolGate(tool, MEMBER, { feedbackId: "feedback-1" }))
      .rejects.toThrow(/not found or access denied/)
  })

  describe("custom field tools", () => {
    it("list_custom_field_definitions is workspace-member gated", async () => {
      mockPrisma.workspace.findFirst.mockResolvedValue(null)
      await expect(applyToolGate("list_custom_field_definitions", MEMBER, { workspaceId: "ws-1" }))
        .rejects.toThrow(/not found or access denied/)
    })

    it.each(["get_custom_field_values", "set_custom_field_value"])(
      "%s denies a non-member of the object's workspace",
      async (tool) => {
        mockPrisma.task.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
        mockPrisma.workspace.findFirst.mockResolvedValue(null)
        await expect(
          applyToolGate(tool, MEMBER, { objectType: "TASK", objectId: "task-1", fieldId: "field-1", value: "x" })
        ).rejects.toThrow(/not found or access denied/)
      }
    )

    it.each(["get_custom_field_values", "set_custom_field_value"])(
      "%s rejects an unknown objectType before touching the database",
      async (tool) => {
        await expect(
          applyToolGate(tool, MEMBER, { objectType: "NOT_A_TYPE", objectId: "task-1", fieldId: "field-1", value: "x" })
        ).rejects.toThrow(/Unknown objectType/)
        expect(mockPrisma.task.findUnique).not.toHaveBeenCalled()
      }
    )

    it("set_custom_field_value allows a member and reaches the handler's own field-level checks", async () => {
      mockPrisma.task.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
      mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
      await expect(
        applyToolGate("set_custom_field_value", MEMBER, { objectType: "TASK", objectId: "task-1", fieldId: "field-1", value: "x" })
      ).resolves.toBeUndefined()
    })
  })
})

// End-to-end through the ACTUAL route wiring: the register() wrapper must run
// the gate before the handler. Drives a captured, gated handler under a
// per-user actor scope — no direct applyToolGate call.
describe("register() wrapper enforces gates end-to-end", () => {
  it("denies update_solution_status before its handler can read or write", async () => {
    mockPrisma.solution.findUnique.mockResolvedValue({ opportunity: { workspaceId: "ws-1" } })
    mockPrisma.workspace.findFirst.mockResolvedValue(null)

    await expect(callTool("update_solution_status", MEMBER, {
      solutionId: "sol-1",
      status: "SHIPPED",
    })).rejects.toThrow(/not found or access denied/)

    expect(mockPrisma.solution.findUnique).toHaveBeenCalledTimes(1)
    expect(mockPrisma.solution.update).not.toHaveBeenCalled()
  })

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
