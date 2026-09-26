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
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// ── Prisma mock (for enforcement cases) ─────────────────────────────────────
const mockPrisma = {
  workspace: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
  workspaceMember: { findFirst: vi.fn() },
  organization: { findUnique: vi.fn() },
  organizationMember: { findFirst: vi.fn() },
  scoringModel: { findUnique: vi.fn() },
  agentOrgAdminGrant: { findFirst: vi.fn() },
  opportunity: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  objective: { findUnique: vi.fn(), findMany: vi.fn() },
  opportunityObjectiveLink: { findMany: vi.fn() },
  solutionKeyResultLink: { findMany: vi.fn() },
  solution: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  roadmapItem: { findUnique: vi.fn(), update: vi.fn() },
  artifact: { findUnique: vi.fn() },
  feedbackItem: { findUnique: vi.fn() },
  doc: { findUnique: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
  reviewRequest: { findUnique: vi.fn() },
  decisionRecord: { findUnique: vi.fn() },
  researchStudy: { findUnique: vi.fn() },
  agent: { findFirst: vi.fn() },
  agentWorkspaceGrant: { findMany: vi.fn() },
  agentToolCall: { create: vi.fn(), update: vi.fn() },
  task: { findUnique: vi.fn() },
  keyResult: { findUnique: vi.fn(), findFirst: vi.fn() },
  squad: { findUnique: vi.fn(), findFirst: vi.fn() },
  customFieldDefinition: { findMany: vi.fn(), findUnique: vi.fn() },
}
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

// ── Capture harness: enumerate the tools route.ts actually registers ────────
const registeredTools: Record<string, unknown> = {}
const registeredResources: Record<string, unknown> = {}
const registeredResourceTemplates: Record<string, { listCallback?: () => unknown }> = {}
vi.mock("mcp-handler", () => ({
  createMcpHandler: (
    setup: (s: {
      registerTool: (n: string, m: unknown, cb: unknown) => void
      registerResource: (n: string, template: { listCallback?: () => unknown }, m: unknown, cb: unknown) => void
    }) => void
  ) => {
    setup({
      registerTool(name, _m, cb) {
        registeredTools[name] = cb
      },
      registerResource(name, template, _m, cb) {
        registeredResources[name] = cb
        registeredResourceTemplates[name] = template
      },
    })
    return () => new Response("ok")
  },
}))
vi.mock("@/lib/mcp-auth", () => ({ validateMcpAuth: vi.fn().mockResolvedValue({ valid: true, userId: "u1" }) }))

await import("@/app/api/mcp/route")
import {
  AGENT_TOOL_POLICY,
  RESEARCH_TOOL_ALLOWLIST,
  TOOL_GATES,
  TOOL_SCOPES,
  applyToolGate,
  requiredToolScope,
  scopesSatisfy,
} from "@/lib/mcp-tool-gates"
import { runWithMcpActor } from "@/lib/mcp-authz"

const MEMBER = { userId: "user-1" }
const SERVICE = { userId: null, purpose: "SERVICE" as const }
const RESEARCH = { userId: "user-1", purpose: "RESEARCH" as const, scopeWorkspaceId: "ws-1" }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const callTool = (name: string, actor: { userId: string | null }, args: any) =>
  runWithMcpActor(actor, () => (registeredTools[name] as (a: unknown) => Promise<unknown>)(args))

beforeEach(() => vi.clearAllMocks())

describe("update_roadmap_item source-workspace link boundaries", () => {
  const targets = [
    ["keyResultId", "keyResult", (workspaceId: string) => ({ objective: { workspaceId } })],
    ["opportunityId", "opportunity", (workspaceId: string) => ({ workspaceId })],
    ["solutionId", "solution", (workspaceId: string) => ({ workspaceId })],
    ["squadId", "squad", (workspaceId: string) => ({ workspaceId })],
  ] as const

  for (const purpose of ["USER", "AGENT"] as const) {
    const actor = () => ({ userId: "user-1", purpose, ...(purpose === "AGENT" ? { agentId: "agent-1", credentialId: "credential-1" } : {}) })
    beforeEach(() => {
      mockPrisma.roadmapItem.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
      // Membership in BOTH workspaces must not allow cross-workspace linkage.
      mockPrisma.workspace.findFirst.mockResolvedValue({ id: "member-workspace" })
      mockPrisma.agent.findFirst.mockResolvedValue({ id: "agent-1" })
      mockPrisma.agentToolCall.create.mockResolvedValue({ id: "activity-1" })
      mockPrisma.agentToolCall.update.mockResolvedValue({})
      mockPrisma.agentWorkspaceGrant.findMany.mockResolvedValue([{ workspaceId: "ws-1" }, { workspaceId: "ws-2" }])
    })
    for (const [field, model, row] of targets) {
      it(`${purpose} accepts same-workspace ${field}`, async () => {
        vi.stubEnv("COMPASS_AGENTS_ENABLED", "1")
        try {
          mockPrisma[model].findUnique.mockResolvedValue(row("ws-1"))
          await expect(applyToolGate("update_roadmap_item", actor(), { itemId: "item-1", [field]: "target" })).resolves.toBeUndefined()
          expect(mockPrisma[model].findUnique).toHaveBeenCalled()
        } finally { vi.unstubAllEnvs() }
      })
      it(`${purpose} rejects foreign ${field} through the registered wrapper without writing`, async () => {
        vi.stubEnv("COMPASS_AGENTS_ENABLED", "1")
        try {
          mockPrisma[model].findUnique.mockResolvedValue(row("ws-2"))
          await expect(callTool("update_roadmap_item", actor(), {
            itemId: "item-1", [field]: "target", title: "must not write", workspaceId: "ws-2",
          })).rejects.toThrow(/does not belong to workspace/)
          expect(mockPrisma.roadmapItem.update).not.toHaveBeenCalled()
          expect(mockPrisma.roadmapItem.findUnique).toHaveBeenCalledTimes(1)
        } finally { vi.unstubAllEnvs() }
      })
      it(`${purpose} rejects missing ${field}`, async () => {
        vi.stubEnv("COMPASS_AGENTS_ENABLED", "1")
        try {
          mockPrisma[model].findUnique.mockResolvedValue(null)
          await expect(applyToolGate("update_roadmap_item", actor(), { itemId: "item-1", [field]: "missing" })).rejects.toThrow(/not found or access denied/)
        } finally { vi.unstubAllEnvs() }
      })
    }
    it(`${purpose} allows null and omitted links without target lookups`, async () => {
      vi.stubEnv("COMPASS_AGENTS_ENABLED", "1")
      try {
        await expect(applyToolGate("update_roadmap_item", actor(), { itemId: "item-1", keyResultId: null, solutionId: null })).resolves.toBeUndefined()
        for (const [, model] of targets) expect(mockPrisma[model].findUnique).not.toHaveBeenCalled()
      } finally { vi.unstubAllEnvs() }
    })
    it(`${purpose} cannot clear links without access to the source item`, async () => {
      vi.stubEnv("COMPASS_AGENTS_ENABLED", "1")
      try {
        mockPrisma.workspace.findFirst.mockResolvedValue(null)
        await expect(callTool("update_roadmap_item", actor(), { itemId: "item-1", squadId: null })).rejects.toThrow(/not found or access denied/)
        expect(mockPrisma.roadmapItem.update).not.toHaveBeenCalled()
      } finally { vi.unstubAllEnvs() }
    })
  }
})

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

describe("ADR 0020: AgentOrgAdminGrant for delegated scoring-model admin", () => {
  const SCORING_ADMIN_TOOLS = ["create_scoring_model", "update_scoring_model", "archive_scoring_model", "set_workspace_scoring_model"]
  const AGENT = { userId: "agent-owner", purpose: "AGENT" as const, agentId: "agent-1" }

  // Args shaped to reach each tool's gate without tripping on an unrelated
  // missing field. set_workspace_scoring_model's scoringModelId is null so
  // the gate never reaches the second, unconditional (non-admin)
  // assertScoringModelAccess call — this test suite is only about the
  // assertWorkspaceAdmin half of that gate.
  function argsFor(tool: string): Record<string, unknown> {
    switch (tool) {
      case "create_scoring_model": return { orgSlug: "acme" }
      case "update_scoring_model": return { scoringModelId: "model-1" }
      case "archive_scoring_model": return { scoringModelId: "model-1" }
      case "set_workspace_scoring_model": return { workspaceId: "ws-1", scoringModelId: null }
      default: throw new Error(`no args mapping for ${tool}`)
    }
  }

  beforeEach(() => {
    vi.stubEnv("COMPASS_AGENTS_ENABLED", "1")
    mockPrisma.agent.findFirst.mockResolvedValue({ id: "agent-1" })
    mockPrisma.organization.findUnique.mockResolvedValue({ id: "org-1" })
    mockPrisma.workspace.findUnique.mockResolvedValue({ organizationId: "org-1" })
    mockPrisma.scoringModel.findUnique.mockResolvedValue({ organizationId: "org-1" })
  })
  afterEach(() => vi.unstubAllEnvs())

  it.each(SCORING_ADMIN_TOOLS)("%s is classified as an agent write, not DENY", (tool) => {
    expect(AGENT_TOOL_POLICY[tool]).toBe("WRITE")
  })

  it.each(SCORING_ADMIN_TOOLS)("%s denies an agent identity with no AgentOrgAdminGrant row", async (tool) => {
    mockPrisma.agentOrgAdminGrant.findFirst.mockResolvedValue(null)
    await expect(applyToolGate(tool, AGENT, argsFor(tool))).rejects.toThrow("Human administrator required.")
  })

  it.each(SCORING_ADMIN_TOOLS)("%s succeeds for an agent identity holding a live, valid grant", async (tool) => {
    mockPrisma.agentOrgAdminGrant.findFirst.mockResolvedValue({ id: "grant-1", grantedByUserId: "grantor-1" })
    mockPrisma.organizationMember.findFirst.mockResolvedValue({ role: "ADMIN" })
    await expect(applyToolGate(tool, AGENT, argsFor(tool))).resolves.toBeUndefined()
  })

  // The load-bearing regression test for the ADR's time-of-check design:
  // revokedAt is still null on the grant row, but the human who issued it no
  // longer holds an org admin role, so the grant must not authorize anything.
  it.each(SCORING_ADMIN_TOOLS)("%s still denies once the grantor has been demoted, even though revokedAt is null", async (tool) => {
    mockPrisma.agentOrgAdminGrant.findFirst.mockResolvedValue({ id: "grant-1", grantedByUserId: "grantor-1" })
    mockPrisma.organizationMember.findFirst.mockResolvedValue({ role: "MEMBER" })
    await expect(applyToolGate(tool, AGENT, argsFor(tool))).rejects.toThrow("Human administrator required.")
  })

  // Proves the grant doesn't leak scope: release authorization stays
  // unconditionally human-only per ADR 0020, even for an agent holding a live
  // grant. (create_workspace left this list when agents began inheriting their
  // owner's org admin rights; see the next describe block.)
  it("request_release_authorization remains denied for an agent identity holding a valid SCORING_MODEL_ADMIN grant", async () => {
    mockPrisma.agentOrgAdminGrant.findFirst.mockResolvedValue({ id: "grant-1", grantedByUserId: "grantor-1" })
    mockPrisma.organizationMember.findFirst.mockResolvedValue({ role: "ADMIN" })
    await expect(applyToolGate("request_release_authorization", AGENT, { workspaceId: "ws-1" })).rejects.toThrow(/human identity/)
  })
})

describe("agents inherit their owner's live org admin rights (create_workspace)", () => {
  const AGENT = { userId: "agent-owner", purpose: "AGENT" as const, agentId: "agent-1" }
  const ARGS = { orgSlug: "acme" }

  beforeEach(() => {
    vi.stubEnv("COMPASS_AGENTS_ENABLED", "1")
    mockPrisma.agent.findFirst.mockResolvedValue({ id: "agent-1" })
    mockPrisma.organization.findUnique.mockResolvedValue({ id: "org-1" })
    // No per-agent AgentOrgAdminGrant exists: inheritance must not need one.
    mockPrisma.agentOrgAdminGrant.findFirst.mockResolvedValue(null)
  })
  afterEach(() => vi.unstubAllEnvs())

  it("is classified as an agent write, not DENY", () => {
    expect(AGENT_TOOL_POLICY.create_workspace).toBe("WRITE")
  })

  it.each(["OWNER", "ADMIN"])("allows an agent whose owner is currently an org %s, with no grant row", async (role) => {
    mockPrisma.organizationMember.findFirst.mockResolvedValue({ role })
    await expect(applyToolGate("create_workspace", AGENT, ARGS)).resolves.toBeUndefined()
    expect(mockPrisma.organizationMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: "org-1", userId: "agent-owner" } }),
    )
  })

  it("allows an AGENT_TURN identity for an admin owner too", async () => {
    mockPrisma.organizationMember.findFirst.mockResolvedValue({ role: "ADMIN" })
    await expect(applyToolGate("create_workspace", { ...AGENT, purpose: "AGENT_TURN" as const }, ARGS)).resolves.toBeUndefined()
  })

  it("denies an agent whose owner is only an org MEMBER", async () => {
    mockPrisma.organizationMember.findFirst.mockResolvedValue({ role: "MEMBER" })
    await expect(applyToolGate("create_workspace", AGENT, ARGS)).rejects.toThrow("Human administrator required.")
  })

  it("denies an agent whose owner is not in the org at all", async () => {
    mockPrisma.organizationMember.findFirst.mockResolvedValue(null)
    await expect(applyToolGate("create_workspace", AGENT, ARGS)).rejects.toThrow("Human administrator required.")
  })

  it("re-checks the owner's role live: the same agent is denied after the owner is demoted", async () => {
    mockPrisma.organizationMember.findFirst.mockResolvedValueOnce({ role: "ADMIN" })
    await expect(applyToolGate("create_workspace", AGENT, ARGS)).resolves.toBeUndefined()
    mockPrisma.organizationMember.findFirst.mockResolvedValueOnce({ role: "MEMBER" })
    await expect(applyToolGate("create_workspace", AGENT, ARGS)).rejects.toThrow("Human administrator required.")
  })

  it("denies an inactive (suspended/missing) agent even when its owner is an admin", async () => {
    mockPrisma.organizationMember.findFirst.mockResolvedValue({ role: "OWNER" })
    mockPrisma.agent.findFirst.mockResolvedValue(null)
    await expect(applyToolGate("create_workspace", AGENT, ARGS)).rejects.toThrow("Human administrator required.")
    expect(mockPrisma.agent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "agent-1", ownerUserId: "agent-owner", status: "ACTIVE" } }),
    )
  })

  it("denies when agents are disabled by rollout flag", async () => {
    vi.stubEnv("COMPASS_AGENTS_ENABLED", "0")
    mockPrisma.organizationMember.findFirst.mockResolvedValue({ role: "OWNER" })
    await expect(applyToolGate("create_workspace", AGENT, ARGS)).rejects.toThrow("Human administrator required.")
  })

  it("denies an agent identity that carries no agentId", async () => {
    mockPrisma.organizationMember.findFirst.mockResolvedValue({ role: "OWNER" })
    await expect(applyToolGate("create_workspace", { userId: "agent-owner", purpose: "AGENT" as const }, ARGS)).rejects.toThrow("Human administrator required.")
  })

  it("denies a workspace-scoped agent identity: it must not mint new workspaces", async () => {
    mockPrisma.organizationMember.findFirst.mockResolvedValue({ role: "OWNER" })
    await expect(applyToolGate("create_workspace", { ...AGENT, purpose: "AGENT_TURN" as const, scopeWorkspaceId: "ws-1" }, ARGS)).rejects.toThrow("Human administrator required.")
  })

  it("does not widen other admin tools: scoring-model admin still needs its own grant", async () => {
    mockPrisma.organizationMember.findFirst.mockResolvedValue({ role: "OWNER" })
    await expect(applyToolGate("create_scoring_model", AGENT, ARGS)).rejects.toThrow("Human administrator required.")
  })

  // Attestation-like tools would be recorded as the human's own act.
  it.each([
    "update_comment", "update_solution_comment", "update_doc_comment",
    "approve_solution_plan", "reject_solution_plan", "request_release_authorization",
  ])("%s stays human-only even for an agent whose owner is an org owner", async (tool) => {
    mockPrisma.organizationMember.findFirst.mockResolvedValue({ role: "OWNER" })
    expect(AGENT_TOOL_POLICY[tool]).toBe("DENY")
    await expect(applyToolGate(tool, AGENT, { workspaceId: "ws-1", commentId: "c-1" })).rejects.toThrow(/human identity/)
  })
})

describe("following tools act on a person's own inbox", () => {
  const FOLLOW_TOOLS = ["follow", "unfollow", "list_notifications", "mark_read"] as const
  const args = { workspaceId: "ws-1", subjectType: "TASK", subjectId: "t-1" }

  it.each(FOLLOW_TOOLS)("%s is human-only: agent-scoped tokens are refused at the gate", async (tool) => {
    expect(AGENT_TOOL_POLICY[tool]).toBe("DENY")
    await expect(applyToolGate(tool, { userId: "u1", purpose: "AGENT", agentId: "agent-1" }, args)).rejects.toThrow(/human identity/)
    await expect(applyToolGate(tool, { userId: "u1", purpose: "AGENT_TURN", agentId: "agent-1" }, args)).rejects.toThrow(/human identity/)
  })

  it.each(FOLLOW_TOOLS)("%s requires membership of the declared workspace for a user key", async (tool) => {
    mockPrisma.workspace.findFirst.mockResolvedValue(null)
    await expect(applyToolGate(tool, { userId: "u1", purpose: "USER" }, args)).rejects.toThrow(/access denied/)
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
    await expect(applyToolGate(tool, { userId: "u1", purpose: "USER" }, args)).resolves.toBeUndefined()
  })

  it("classifies list_notifications as a read and the other three as writes", () => {
    expect(TOOL_SCOPES.list_notifications).toBe("mcp:read")
    for (const tool of ["follow", "unfollow", "mark_read"] as const) expect(TOOL_SCOPES[tool]).toBe("mcp:write")
  })
})

describe("feedback source tools are gated like create_artifact", () => {
  const tools = ["create_feedback_source", "update_feedback_source"]
  it.each(tools)("%s admits a plain workspace member", async (tool) => {
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
    await expect(applyToolGate(tool, MEMBER, { workspaceId: "ws-1" })).resolves.toBeUndefined()
  })
  it.each(tools)("%s denies a non-member", async (tool) => {
    mockPrisma.workspace.findFirst.mockResolvedValue(null)
    await expect(applyToolGate(tool, MEMBER, { workspaceId: "ws-1" })).rejects.toThrow(/not found or access denied/)
  })
  it.each(tools)("%s is write-scoped and allowed for agents exactly as create_artifact is", async (tool) => {
    expect(requiredToolScope(tool)).toBe("mcp:write")
    expect(AGENT_TOOL_POLICY[tool]).toBe(AGENT_TOOL_POLICY.create_artifact)
    expect(AGENT_TOOL_POLICY[tool]).toBe("WRITE")
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
    mockPrisma.agent.findFirst.mockResolvedValue({ id: "agent" })
    const agent = { userId: "user-1", purpose: "AGENT" as const, agentId: "agent" }
    await expect(applyToolGate("create_artifact", agent, { workspaceId: "ws-1" })).resolves.toBeUndefined()
    await expect(applyToolGate(tool, agent, { workspaceId: "ws-1" })).resolves.toBeUndefined()
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

/**
 * The same fail-closed completeness contract TOOL_GATES has, for the OAuth
 * read/write classification. Without it a tool added after this phase would
 * silently inherit `requiredToolScope`'s `mcp:write` default — safe, but a
 * write-scope demand nobody chose, on a tool that might be a pure read.
 */
describe("TOOL_SCOPES completeness", () => {
  it("classifies every registered tool as read or write", () => {
    const missing = Object.keys(registeredTools).filter((name) => !(name in TOOL_SCOPES))
    expect(missing).toEqual([])
  })

  it("has no scope entries for tools that are not registered", () => {
    const dead = Object.keys(TOOL_SCOPES).filter((name) => !(name in registeredTools))
    expect(dead).toEqual([])
  })

  it("classifies exactly the whole catalog, with no third value", () => {
    expect(Object.keys(TOOL_SCOPES).length).toBe(Object.keys(registeredTools).length)
    expect([...new Set(Object.values(TOOL_SCOPES))].sort()).toEqual(["mcp:read", "mcp:write"])
  })

  it("keeps the read/write split aligned with the obvious naming conventions", () => {
    // Not a tautology against the map: it re-derives the expectation from the
    // tool NAMES, so a get_*/list_* tool silently classified as a write (or a
    // create_*/update_*/delete_* one as a read) fails here.
    const misread = Object.keys(registeredTools).filter(
      (name) => /^(get|list|search)_/.test(name) && TOOL_SCOPES[name] !== "mcp:read",
    )
    const miswritten = Object.keys(registeredTools).filter(
      (name) =>
        /^(create|update|delete|add|remove|archive|link|unlink|promote|set|move|assign|revoke|rotate|issue|close|reopen|resolve|approve|reject|conclude|restore|score|log)_/.test(name) &&
        TOOL_SCOPES[name] !== "mcp:write",
    )
    expect({ misread, miswritten }).toEqual({ misread: [], miswritten: [] })
  })

  it("demands the stronger scope for a tool it has never heard of", () => {
    expect(requiredToolScope("totally_new_tool")).toBe("mcp:write")
  })

  it("treats mcp:write as covering reads, and read alone as not covering writes", () => {
    expect(scopesSatisfy(["mcp:read"], "mcp:read")).toBe(true)
    expect(scopesSatisfy(["mcp:read"], "mcp:write")).toBe(false)
    expect(scopesSatisfy(["mcp:write"], "mcp:read")).toBe(true)
    expect(scopesSatisfy(["mcp:write"], "mcp:write")).toBe(true)
    expect(scopesSatisfy(["offline_access"], "mcp:read")).toBe(false)
    expect(scopesSatisfy([], "mcp:read")).toBe(false)
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
    mockPrisma.solution.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.solution.findFirst.mockResolvedValue({ id: "solution-1" })
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
    mockPrisma.solution.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" }) // member of the real workspace
    await expect(
      applyToolGate("promote_to_roadmap", MEMBER, { solutionId: "sol-1", workspaceId: "ws-2" })
    ).rejects.toThrow(/does not belong to workspace/)
  })

  it("update_roadmap_item rejects a missing or inaccessible Solution before writing", async () => {
    mockPrisma.roadmapItem.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
    mockPrisma.solution.findUnique.mockResolvedValue(null)

    await expect(callTool("update_roadmap_item", MEMBER, {
      itemId: "item-1",
      solutionId: "missing-solution",
    })).rejects.toThrow(/solution not found or access denied/)

    expect(mockPrisma.roadmapItem.update).not.toHaveBeenCalled()
  })

  it("update_roadmap_item rejects a cross-workspace Solution before writing", async () => {
    mockPrisma.roadmapItem.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
    mockPrisma.solution.findUnique.mockResolvedValue({ workspaceId: "ws-2" })

    await expect(callTool("update_roadmap_item", MEMBER, {
      itemId: "item-1",
      solutionId: "foreign-solution",
    })).rejects.toThrow(/does not belong to workspace ws-1/)

    expect(mockPrisma.roadmapItem.update).not.toHaveBeenCalled()
  })

  it("update_roadmap_item authorizes same-workspace targets and forwards solutionId to the handler", async () => {
    mockPrisma.roadmapItem.findUnique.mockResolvedValue({
      id: "item-1",
      workspaceId: "ws-1",
      title: "Roadmap item",
      horizon: "NEXT",
      status: "ACTIVE",
    })
    mockPrisma.solution.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
    mockPrisma.roadmapItem.update.mockResolvedValue({
      id: "item-1",
      title: "Roadmap item",
      horizon: "NEXT",
      status: "ACTIVE",
      solutionId: "solution-1",
      isPrivate: false,
      startDate: null,
      endDate: null,
    })

    await expect(callTool("update_roadmap_item", MEMBER, {
      itemId: "item-1",
      solutionId: "solution-1",
    })).resolves.toBeDefined()

    expect(mockPrisma.roadmapItem.update).toHaveBeenCalledWith({
      where: { id: "item-1" },
      data: { solutionId: "solution-1", updatedAt: expect.any(Date) },
    })
  })

  it("link_artifact_to_solution: rejects cross-workspace targets", async () => {
    mockPrisma.artifact.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.solution.findUnique.mockResolvedValue({ workspaceId: "ws-2" })
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
    mockPrisma.solution.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
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
    // The additive linkedObjectives read: workspace-checked opportunity, then its (empty) link rows.
    mockPrisma.opportunity.findMany.mockResolvedValue([{ id: "opp-1" }])
    mockPrisma.opportunityObjectiveLink.findMany.mockResolvedValue([])
    const result = (await callTool("get_opportunity", MEMBER, { opportunityId: "opp-1" })) as {
      content: { text: string }[]
    }
    expect(result.content[0].text).toContain("Reduce churn")
  })
})

// ── Typed links (ADR Phase 2) ───────────────────────────────────────────────
describe("typed link tools are classified, gated, and same-workspace", () => {
  const writeTools = ["link_opportunity_to_objective", "unlink_opportunity_from_objective", "link_solution_to_key_result", "unlink_solution_from_key_result"]
  const entityRow: Record<string, (workspaceId: string) => unknown> = {
    opportunity: (workspaceId) => ({ workspaceId }),
    solution: (workspaceId) => ({ workspaceId }),
    objective: (workspaceId) => ({ workspaceId }),
    keyResult: (workspaceId) => ({ objective: { workspaceId } }),
  }
  const seed = (rows: Record<string, string | null>) => {
    for (const [model, workspaceId] of Object.entries(rows)) {
      ;(mockPrisma as unknown as Record<string, { findUnique: ReturnType<typeof vi.fn> }>)[model].findUnique.mockResolvedValue(workspaceId ? entityRow[model](workspaceId) : null)
    }
  }

  it.each(writeTools)("%s is a registered write: mcp:write scope, WRITE for agents", (tool) => {
    expect(tool in registeredTools).toBe(true)
    expect(tool in TOOL_GATES).toBe(true)
    expect(requiredToolScope(tool)).toBe("mcp:write")
    expect(AGENT_TOOL_POLICY[tool]).toBe("WRITE")
  })

  it("list_links is a registered read: mcp:read scope, READ for agents", () => {
    expect("list_links" in registeredTools).toBe(true)
    expect(requiredToolScope("list_links")).toBe("mcp:read")
    expect(AGENT_TOOL_POLICY.list_links).toBe("READ")
  })

  const cases: [string, Record<string, unknown>, Record<string, string | null>][] = [
    ["link_opportunity_to_objective", { workspaceId: "ws-1", opportunityId: "o", objectiveId: "ob" }, { opportunity: "ws-1", objective: "ws-1" }],
    ["unlink_opportunity_from_objective", { workspaceId: "ws-1", opportunityId: "o", objectiveId: "ob" }, { opportunity: "ws-1" }],
    ["link_solution_to_key_result", { workspaceId: "ws-1", solutionId: "s", keyResultId: "k" }, { solution: "ws-1", keyResult: "ws-1" }],
    ["unlink_solution_from_key_result", { workspaceId: "ws-1", solutionId: "s", keyResultId: "k" }, { solution: "ws-1" }],
    ["list_links", { workspaceId: "ws-1", opportunityId: "o" }, { opportunity: "ws-1" }],
    ["list_links", { workspaceId: "ws-1", objectiveId: "ob" }, { objective: "ws-1" }],
    ["list_links", { workspaceId: "ws-1", solutionId: "s" }, { solution: "ws-1" }],
    ["list_links", { workspaceId: "ws-1", keyResultId: "k" }, { keyResult: "ws-1" }],
  ]

  it.each(cases)("%s admits a member of the declared workspace (%j)", async (tool, args, rows) => {
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
    seed(rows)
    await expect(applyToolGate(tool, MEMBER, args)).resolves.toBeUndefined()
  })

  it.each(cases)("%s denies a non-member (%j)", async (tool, args, rows) => {
    mockPrisma.workspace.findFirst.mockResolvedValue(null)
    seed(rows)
    await expect(applyToolGate(tool, MEMBER, args)).rejects.toThrow(/not found or access denied/)
  })

  it.each(cases)("%s denies an entity that is in another workspace than the declared one (%j)", async (tool, args, rows) => {
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
    seed(Object.fromEntries(Object.keys(rows).map((model) => [model, "ws-2"])))
    await expect(applyToolGate(tool, MEMBER, args)).rejects.toThrow(/does not belong to workspace/)
  })

  it("link_opportunity_to_objective denies a foreign objective even though the opportunity is the member's", async () => {
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
    seed({ opportunity: "ws-1", objective: "ws-2" })
    await expect(applyToolGate("link_opportunity_to_objective", MEMBER, { workspaceId: "ws-1", opportunityId: "o", objectiveId: "ob" })).rejects.toThrow(/does not belong to workspace/)
  })

  it("agents without a write grant are denied the write tools at the workspace gate", async () => {
    vi.stubEnv("COMPASS_AGENTS_ENABLED", "1")
    try {
      mockPrisma.agent.findFirst.mockResolvedValue({ id: "agent" })
      mockPrisma.agentWorkspaceGrant.findMany.mockResolvedValue([])
      mockPrisma.workspace.findFirst.mockResolvedValue(null)
      seed({ opportunity: "ws-1", objective: "ws-1" })
      await expect(applyToolGate("link_opportunity_to_objective", { userId: "user-1", purpose: "AGENT", agentId: "agent" }, { workspaceId: "ws-1", opportunityId: "o", objectiveId: "ob" })).rejects.toThrow(/not found or access denied/)
    } finally { vi.unstubAllEnvs() }
  })

  it("public research credentials get none of them", async () => {
    for (const tool of [...writeTools, "list_links"]) {
      await expect(applyToolGate(tool, RESEARCH, { workspaceId: "ws-1" })).rejects.toThrow(/not available to research interviews/)
    }
  })
})

describe("link_opportunity_to_kr and create_opportunity reject a key result from another workspace", () => {
  it("rejects a cross-workspace KR for a member of both workspaces (the gate used to check access to each independently)", async () => {
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "member-of-both" })
    mockPrisma.opportunity.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.keyResult.findUnique.mockResolvedValue({ objective: { workspaceId: "ws-2" } })
    await expect(applyToolGate("link_opportunity_to_kr", MEMBER, { opportunityId: "o", keyResultId: "k" })).rejects.toThrow(/same workspace/)
  })

  it("rejects it through the registered wrapper without any write", async () => {
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "member-of-both" })
    mockPrisma.opportunity.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.keyResult.findUnique.mockResolvedValue({ objective: { workspaceId: "ws-2" } })
    await expect(callTool("link_opportunity_to_kr", MEMBER, { opportunityId: "o", keyResultId: "k" })).rejects.toThrow(/same workspace/)
    expect(mockPrisma.opportunity.update).not.toHaveBeenCalled()
  })

  it("admits a same-workspace KR, and a null keyResultId only needs the opportunity", async () => {
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
    mockPrisma.opportunity.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.keyResult.findUnique.mockResolvedValue({ objective: { workspaceId: "ws-1" } })
    await expect(applyToolGate("link_opportunity_to_kr", MEMBER, { opportunityId: "o", keyResultId: "k" })).resolves.toBeUndefined()
    mockPrisma.keyResult.findUnique.mockClear()
    await expect(applyToolGate("link_opportunity_to_kr", MEMBER, { opportunityId: "o", keyResultId: null })).resolves.toBeUndefined()
    expect(mockPrisma.keyResult.findUnique).not.toHaveBeenCalled()
  })

  it("denies a non-member of the opportunity's workspace before comparing workspaces (no existence leak)", async () => {
    mockPrisma.workspace.findFirst.mockResolvedValue(null)
    mockPrisma.opportunity.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.keyResult.findUnique.mockResolvedValue({ objective: { workspaceId: "ws-2" } })
    await expect(applyToolGate("link_opportunity_to_kr", MEMBER, { opportunityId: "o", keyResultId: "k" })).rejects.toThrow(/not found or access denied/)
  })

  it("create_opportunity denies a keyResultId from another workspace than the declared one", async () => {
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
    mockPrisma.keyResult.findUnique.mockResolvedValue({ objective: { workspaceId: "ws-2" } })
    await expect(applyToolGate("create_opportunity", MEMBER, { workspaceId: "ws-1", keyResultId: "k" })).rejects.toThrow(/does not belong to workspace/)
    mockPrisma.keyResult.findUnique.mockResolvedValue({ objective: { workspaceId: "ws-1" } })
    await expect(applyToolGate("create_opportunity", MEMBER, { workspaceId: "ws-1", keyResultId: "k" })).resolves.toBeUndefined()
    await expect(applyToolGate("create_opportunity", MEMBER, { workspaceId: "ws-1" })).resolves.toBeUndefined()
  })
})

describe("card sort tool policy", () => {
  const WRITE_TOOLS = ["create_card_sort_round", "set_card_sort_round_state", "propose_card_sort_move", "withdraw_card_sort_proposal"]
  const READ_TOOL_NAMES = ["list_card_sort_factors", "list_card_sort_rounds", "get_card_sort_proposals", "get_card_sort_board", "get_card_sort_tally"]
  const ALL = [...WRITE_TOOLS, ...READ_TOOL_NAMES]

  it.each(ALL)("%s is registered and has a TOOL_GATES entry", (tool) => {
    expect(registeredTools[tool]).toBeTypeOf("function")
    expect(TOOL_GATES[tool]).toBeTypeOf("function")
  })

  // A CardSortProposal has no agent author column, so an agent's proposal would be
  // stored as, and read back as, the delegating human's own opinion.
  it.each(WRITE_TOOLS)("%s is human-only (DENY for agent identities)", (tool) => {
    expect(AGENT_TOOL_POLICY[tool]).toBe("DENY")
  })
  it.each(READ_TOOL_NAMES)("%s is an ordinary agent read", (tool) => {
    expect(AGENT_TOOL_POLICY[tool]).toBe("READ")
  })

  it.each(WRITE_TOOLS)("%s is refused for an agent identity even with a workspace grant", async (tool) => {
    vi.stubEnv("COMPASS_AGENTS_ENABLED", "1")
    try {
      mockPrisma.agent.findFirst.mockResolvedValue({ id: "agent" })
      mockPrisma.agentWorkspaceGrant.findMany.mockResolvedValue([{ workspaceId: "ws-1" }])
      mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
      await expect(
        applyToolGate(tool, { userId: "user-1", purpose: "AGENT", agentId: "agent" }, { workspaceId: "ws-1" }),
      ).rejects.toThrow(/human identity/)
    } finally { vi.unstubAllEnvs() }
  })

  it.each(ALL)("%s requires workspace membership for a per-user caller", async (tool) => {
    mockPrisma.workspace.findFirst.mockResolvedValue(null)
    await expect(applyToolGate(tool, MEMBER, { workspaceId: "ws-1" })).rejects.toThrow(/not found or access denied/)

    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
    await expect(applyToolGate(tool, MEMBER, { workspaceId: "ws-1" })).resolves.toBeUndefined()
  })

  it.each(READ_TOOL_NAMES)("%s needs only the read OAuth scope", (tool) => {
    expect(requiredToolScope(tool)).toBe("mcp:read")
  })
  it.each(WRITE_TOOLS)("%s needs the write OAuth scope", (tool) => {
    expect(requiredToolScope(tool)).toBe("mcp:write")
  })
})

// ADR 0019 — Docs as a Virtual Filesystem. Resources have no tool name for
// TOOL_GATES to key on, so they are gated directly in the route's resource
// callbacks (lib/mcp-authz.ts's assertWorkspaceMember) -- these exercise that
// path end-to-end through the real registration captured above.
describe("docs:// resource — read/list", () => {
  const docRow = {
    id: "doc-1",
    title: "Q3 Plan",
    parentId: null,
    roadmapItemId: null,
    docType: "STANDARD",
    updatedAt: new Date("2026-01-01"),
    workspaceId: "ws-1",
    content: "Body",
    metadata: null,
    icon: null,
    revision: "rev-1",
    storageProvider: null,
    contentRef: null,
  }

  it("read: denies a non-member", async () => {
    mockPrisma.doc.findMany.mockResolvedValue([docRow])
    mockPrisma.workspace.findFirst.mockResolvedValue(null)
    const read = registeredResources.doc as (uri: URL, vars: Record<string, string>) => Promise<unknown>
    await expect(runWithMcpActor(MEMBER, () => read(new URL("docs://ws-1/Q3%20Plan"), { workspaceId: "ws-1", path: "Q3 Plan" })))
      .rejects.toThrow(/not found or access denied/)
  })

  it("read: returns frontmatter + body for a member", async () => {
    mockPrisma.doc.findMany.mockResolvedValue([docRow])
    mockPrisma.doc.findUnique.mockResolvedValue(docRow)
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
    const read = registeredResources.doc as (uri: URL, vars: Record<string, string>) => Promise<{ contents: { text: string }[] }>
    const result = await runWithMcpActor(MEMBER, () => read(new URL("docs://ws-1/Q3%20Plan"), { workspaceId: "ws-1", path: "Q3 Plan" }))
    expect(result.contents[0].text).toContain("compass_doc_id: doc-1")
    expect(result.contents[0].text).toContain("Body")
  })

  it("read: research actors are denied entirely", async () => {
    const read = registeredResources.doc as (uri: URL, vars: Record<string, string>) => Promise<unknown>
    await expect(runWithMcpActor(RESEARCH, () => read(new URL("docs://ws-1/Q3%20Plan"), { workspaceId: "ws-1", path: "Q3 Plan" })))
      .rejects.toThrow(/not available to research interviews/)
  })

  it("list: enumerates every workspace the caller can access", async () => {
    mockPrisma.workspace.findMany.mockResolvedValue([{ id: "ws-1" }])
    mockPrisma.doc.findMany.mockResolvedValue([docRow])
    const list = registeredResourceTemplates.doc.listCallback as unknown as () => Promise<{ resources: { uri: string; name: string }[] }>
    const result = await runWithMcpActor(MEMBER, () => list())
    expect(result.resources).toEqual([{ uri: "docs://ws-1/Q3%20Plan", name: "Q3 Plan", mimeType: "text/markdown" }])
  })

  it("list: research actors are denied entirely", async () => {
    const list = registeredResourceTemplates.doc.listCallback as unknown as () => Promise<unknown>
    await expect(runWithMcpActor(RESEARCH, () => list())).rejects.toThrow(/not available to research interviews/)
  })
})
