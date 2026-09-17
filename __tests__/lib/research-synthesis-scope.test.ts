import { beforeEach, describe, expect, it, vi } from "vitest"
import { runWithMcpActor, type McpActor } from "@/lib/mcp-authz"
import { RESEARCH_SYNTHESIS_TOOLS } from "@/lib/research-handoff-scope"
import { gateInterviewTool, withInterviewMutation } from "@/lib/pm-agent-service"
import { applyToolGate } from "@/lib/mcp-tool-gates"

/**
 * ADR-0012 step 4, the scoped phase's security boundary.
 *
 * A `RESEARCH_SYNTHESIS` claim may read its own study and write its own
 * `ResearchSynthesis` row. It must not be able to touch discovery state — the
 * ADR is explicit that promotion into Evidence happens later, in an unscoped
 * turn carrying the researcher's own authority.
 *
 * `gateInterviewTool` is the enforcement point: it runs inside `applyToolGate`,
 * which `register()` in app/api/mcp/route.ts calls before every handler.
 */
const db = vi.hoisted(() => ({ prisma: null as unknown }))
vi.mock("@/lib/db", () => ({ default: () => db.prisma }))

const WORKSPACE_ID = "workspace-1"
const USER_ID = "user-1"
const CONVERSATION_ID = "conversation-1"
const CLAIM_ID = "claim-1"
const STUDY_ID = "study-1"
const OTHER_STUDY_ID = "study-2"

const actor: McpActor = { purpose: "AGENT_TURN", userId: USER_ID, scopeWorkspaceId: WORKSPACE_ID, scopeConversationId: CONVERSATION_ID, scopeClaimId: CLAIM_ID }

let state: Record<string, unknown>

function installPrisma() {
  const client = {
    workspaceMember: { findFirst: async () => ({ id: "member-1" }) },
    // Reached by assertWorkspaceMember / assertEntityAccess in the per-tool gates.
    workspace: { findFirst: async () => ({ id: WORKSPACE_ID }) },
    researchStudy: { findUnique: async () => ({ workspaceId: WORKSPACE_ID }) },
    opportunity: { findUnique: async () => ({ workspaceId: WORKSPACE_ID }) },
    agentConversation: { findFirst: async () => ({ id: CONVERSATION_ID, userId: USER_ID, workspaceId: WORKSPACE_ID, interviewProcessingJson: JSON.stringify(state) }) },
    pMInterview: { findFirst: async () => null },
    agent: { findFirst: async () => null },
    agentWorkspaceGrant: { findMany: async () => [] },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(client),
  }
  db.prisma = client
}

beforeEach(() => {
  state = { status: "RUNNING", kind: "RESEARCH_SYNTHESIS", claimId: CLAIM_ID, studyId: STUDY_ID, deadline: Date.now() + 240_000, targetUrl: "/acme/product/capture/studies/study-1" }
  installPrisma()
})

const ALLOWED = ["get_research_study", "list_research_sessions", "get_research_session", "list_research_syntheses", "generate_research_synthesis"]

describe("RESEARCH_SYNTHESIS scoped allowlist", () => {
  it("declares exactly the five tools ADR-0012 step 4 permits", () => {
    expect([...RESEARCH_SYNTHESIS_TOOLS].sort()).toEqual([...ALLOWED].sort())
  })

  it.each(ALLOWED)("permits %s for the study bound to the claim", async tool => {
    await expect(gateInterviewTool(actor, tool, { workspaceId: WORKSPACE_ID, studyId: STUDY_ID, sessionId: "session-1", synthesis: {} })).resolves.toBeUndefined()
  })

  it.each(ALLOWED)("rejects %s when pointed at a different study", async tool => {
    await expect(gateInterviewTool(actor, tool, { workspaceId: WORKSPACE_ID, studyId: OTHER_STUDY_ID, sessionId: "session-1", synthesis: {} })).rejects.toThrow(/outside this research synthesis/)
  })

  it.each(ALLOWED)("rejects %s when the studyId is missing entirely", async tool => {
    await expect(gateInterviewTool(actor, tool, { workspaceId: WORKSPACE_ID })).rejects.toThrow(/outside this research synthesis/)
  })

  it("rejects every allowlisted tool when the claim itself carries no studyId", async () => {
    delete state.studyId
    installPrisma()
    for (const tool of ALLOWED) {
      await expect(gateInterviewTool(actor, tool, { workspaceId: WORKSPACE_ID, studyId: STUDY_ID })).rejects.toThrow(/outside this research synthesis/)
    }
  })
})

describe("RESEARCH_SYNTHESIS cannot mutate discovery state", () => {
  // ADR-0012: "It must not write discovery state: no Evidence, opportunity,
  // solution, assumption, experiment, feedback, or roadmap mutation."
  const DENIED = [
    ["add_evidence", { workspaceId: WORKSPACE_ID, opportunityId: "opportunity-1", summary: "x" }],
    ["link_evidence", { evidenceId: "evidence-1", opportunityId: "opportunity-1" }],
    ["update_opportunity", { opportunityId: "opportunity-1", title: "x" }],
    ["update_opportunity_status", { opportunityId: "opportunity-1", status: "VALIDATING" }],
    ["create_opportunity", { workspaceId: WORKSPACE_ID, title: "x" }],
    ["create_task", { workspaceId: WORKSPACE_ID, title: "x" }],
    ["create_feedback", { workspaceId: WORKSPACE_ID, title: "x" }],
    ["promote_to_roadmap", { workspaceId: WORKSPACE_ID, solutionId: "solution-1" }],
    ["add_to_roadmap", { workspaceId: WORKSPACE_ID, title: "x" }],
    ["add_solution", { opportunityId: "opportunity-1", title: "x" }],
    ["add_assumption", { solutionId: "solution-1", statement: "x" }],
    ["create_experiment", { workspaceId: WORKSPACE_ID, title: "x" }],
    ["request_decision", { workspaceId: WORKSPACE_ID, subjectType: "WORKSPACE", subjectId: WORKSPACE_ID }],
    ["create_doc", { workspaceId: WORKSPACE_ID, title: "x" }],
    ["add_comment", { workspaceId: WORKSPACE_ID, targetType: "RESEARCH_STUDY", targetId: STUDY_ID, body: "x", authorName: "x" }],
    // Participant-link issuance is study-scoped and would otherwise "belong" to
    // the bound study — the allowlist, not the study binding, is what stops it.
    ["issue_research_link", { workspaceId: WORKSPACE_ID, studyId: STUDY_ID }],
    ["rotate_research_link", { workspaceId: WORKSPACE_ID, studyId: STUDY_ID }],
    ["revoke_research_links", { workspaceId: WORKSPACE_ID, studyId: STUDY_ID }],
    ["update_research_study", { workspaceId: WORKSPACE_ID, studyId: STUDY_ID, name: "x" }],
    ["archive_research_study", { workspaceId: WORKSPACE_ID, studyId: STUDY_ID }],
    // The PM handoff's own tools are a different domain's authority entirely.
    ["get_pm_interview", { interviewId: "interview-1" }],
    ["list_research_studies", { workspaceId: WORKSPACE_ID }],
  ] as const

  it.each(DENIED)("denies %s under a RESEARCH_SYNTHESIS claim", async (tool, args) => {
    await expect(gateInterviewTool(actor, tool, args as Record<string, unknown>)).rejects.toThrow(/outside this research synthesis/)
  })

  it("denies a discovery write even when the caller smuggles in the bound studyId", async () => {
    await expect(gateInterviewTool(actor, "add_evidence", { workspaceId: WORKSPACE_ID, studyId: STUDY_ID, opportunityId: "opportunity-1" })).rejects.toThrow(/outside this research synthesis/)
  })
})

describe("claim lifecycle still fences the research kind", () => {
  it("rejects a superseded claim id", async () => {
    await expect(gateInterviewTool({ ...actor, scopeClaimId: "stale" }, "get_research_study", { workspaceId: WORKSPACE_ID, studyId: STUDY_ID })).rejects.toThrow(/expired/)
  })

  it("rejects an expired deadline", async () => {
    state.deadline = Date.now() - 1
    installPrisma()
    await expect(gateInterviewTool(actor, "get_research_study", { workspaceId: WORKSPACE_ID, studyId: STUDY_ID })).rejects.toThrow(/expired/)
  })

  it("rejects a revoked workspace membership", async () => {
    installPrisma()
    ;(db.prisma as { workspaceMember: { findFirst: () => Promise<unknown> } }).workspaceMember.findFirst = async () => null
    await expect(gateInterviewTool(actor, "get_research_study", { workspaceId: WORKSPACE_ID, studyId: STUDY_ID })).rejects.toThrow(/access denied/)
  })
})

describe("end-to-end through applyToolGate, the way register() calls it", () => {
  // gateInterviewTool is only the first of three layers. This drives the whole
  // chain — scoped allowlist, then AGENT_TOOL_POLICY, then the per-tool
  // workspace gate — under the real AGENT_TURN credential the turn route mints.
  it.each(ALLOWED)("admits %s for the bound study", async tool => {
    await expect(applyToolGate(tool, actor, { workspaceId: WORKSPACE_ID, studyId: STUDY_ID, sessionId: "session-1", synthesis: {} })).resolves.toBeUndefined()
  })

  it.each(["add_evidence", "update_opportunity", "create_task", "promote_to_roadmap", "issue_research_link", "add_to_roadmap", "create_feedback", "request_decision"])(
    "denies %s before any per-tool gate or handler runs",
    async tool => {
      await expect(applyToolGate(tool, actor, { workspaceId: WORKSPACE_ID, studyId: STUDY_ID, opportunityId: "opportunity-1", solutionId: "solution-1", feedbackId: "feedback-1", title: "x", subjectType: "WORKSPACE", subjectId: WORKSPACE_ID })).rejects.toThrow(/outside this research synthesis/)
    },
  )

  it("still refuses a bound study that turns out to live in another workspace", async () => {
    // Defence in depth: even past the study binding, the credential is pinned to
    // one workspace, so a study that resolves elsewhere is denied by scope.
    ;(db.prisma as { researchStudy: { findUnique: () => Promise<unknown> } }).researchStudy.findUnique = async () => ({ workspaceId: "workspace-2" })
    await expect(applyToolGate("get_research_session", actor, { workspaceId: WORKSPACE_ID, studyId: STUDY_ID, sessionId: "session-1" })).rejects.toThrow(/not found or access denied/)
  })
})

describe("gate ordering (ADR-0012 Risks: 'verify deliberately')", () => {
  // gateInterviewTool runs BEFORE applyToolGate's service-actor early return, so
  // adding a kind must not drag unscoped credentials through the new branch.
  it("leaves the shared service key on its existing short-circuit", async () => {
    await expect(applyToolGate("add_evidence", { userId: null, purpose: "SERVICE" }, { workspaceId: WORKSPACE_ID, opportunityId: "opportunity-1" })).resolves.toBeUndefined()
  })

  it("leaves an ordinary unscoped member turn untouched", async () => {
    await expect(applyToolGate("get_research_session", { userId: USER_ID, purpose: "USER" }, { workspaceId: WORKSPACE_ID, studyId: OTHER_STUDY_ID, sessionId: "session-1" })).resolves.toBeUndefined()
  })

  it("leaves an unscoped AGENT_TURN credential on the ordinary agent policy", async () => {
    // An AGENT_TURN key always carries scopeWorkspaceId; only scopeConversationId
    // marks it as claimed, so without one the research allowlist never applies.
    await expect(applyToolGate("update_opportunity", { userId: USER_ID, purpose: "AGENT_TURN", scopeWorkspaceId: WORKSPACE_ID }, { opportunityId: "opportunity-1", title: "x" })).resolves.toBeUndefined()
  })
})

describe("withInterviewMutation passes the research kind through untouched", () => {
  it("runs the handler without the PM receipt machinery", async () => {
    const handler = vi.fn(async () => "handled")
    const result = await runWithMcpActor(actor, () => withInterviewMutation("generate_research_synthesis", { workspaceId: WORKSPACE_ID, studyId: STUDY_ID }, handler))
    expect(handler).toHaveBeenCalledTimes(1)
    expect(result).toBe("handled")
  })

  it("still refuses a superseded claim before reaching the handler", async () => {
    const handler = vi.fn()
    await expect(runWithMcpActor({ ...actor, scopeClaimId: "stale" }, () => withInterviewMutation("generate_research_synthesis", { workspaceId: WORKSPACE_ID, studyId: STUDY_ID }, handler))).rejects.toThrow(/expired/)
    expect(handler).not.toHaveBeenCalled()
  })
})
