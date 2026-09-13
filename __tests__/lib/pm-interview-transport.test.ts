import { beforeEach, describe, expect, it, vi } from "vitest"

const ids = {
  interview: "00000000-0000-4000-8000-000000000101",
  target: "00000000-0000-4000-8000-000000000102",
  session: "00000000-0000-4000-8000-000000000103",
  turn: "00000000-0000-4000-8000-000000000104",
  owner: "00000000-0000-4000-8000-000000000105",
}

const mocks = vi.hoisted(() => ({
  respond: vi.fn(),
  complete: vi.fn(),
  agent: vi.fn(),
  workspace: { findFirst: vi.fn() },
  pMInterview: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  agentConversation: { create: vi.fn(), findFirst: vi.fn() },
  transaction: vi.fn(),
  participantToken: { findFirst: vi.fn() },
}))

vi.mock("@/lib/db", () => ({ default: () => ({
  workspace: mocks.workspace,
  pMInterview: mocks.pMInterview,
  researchParticipantToken: mocks.participantToken,
  agentConversation: mocks.agentConversation,
  $transaction: mocks.transaction,
}) }))
vi.mock("@/lib/research-agent", () => ({ runResearchInterviewAgent: mocks.agent }))
vi.mock("@/lib/research-session", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/research-session")>()
  return { ...original, respondToResearchSession: mocks.respond, completeResearchSession: mocks.complete }
})

import { completePmInterview, respondToPmInterview } from "@/lib/pm-interview-service"

const scope = { orgSlug: "acme", workspaceSlug: "product" }
const actor = { userId: ids.owner }
const context = {
  version: 1,
  capturedAt: "2026-09-11T12:00:00.000Z",
  target: { type: "OPPORTUNITY", id: ids.target, fields: { title: "Activation is slow", description: null, customerSegment: null, status: "EXPLORING" } },
  parents: [],
  outcome: null,
  evidence: [],
  feedback: [],
  omissions: [],
}

function interview(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.interview,
    workspaceId: "workspace-1",
    studyId: "study-1",
    sessionId: ids.session,
    initiatingUserId: ids.owner,
    targetType: "OPPORTUNITY",
    targetId: ids.target,
    contextSnapshotJson: JSON.stringify(context),
    fieldBaselineJson: JSON.stringify({ version: 1, fields: { title: "Activation is slow", description: null, customerSegment: null } }),
    proposalJson: null,
    generationState: "NOT_STARTED",
    generationClaimedAt: null,
    disposition: "PENDING",
    session: {
      id: ids.session,
      status: "IN_PROGRESS",
      modality: "CHAT",
      participantTokenId: "internal-token-id",
      turns: [
        { id: "00000000-0000-4000-8000-000000000106", role: "INTERVIEWER", content: "Who experiences this?", sequence: 0 },
        { id: ids.turn, role: "PARTICIPANT", content: "I believe new teams struggle.", sequence: 1 },
      ],
    },
    study: { id: "study-1", name: "PM interview", studyType: "PM_INTERVIEW", guide: "[]" },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.workspace.findFirst.mockResolvedValue({ id: "workspace-1" })
  mocks.pMInterview.findFirst.mockResolvedValue(interview())
  mocks.pMInterview.findUnique.mockResolvedValue(interview())
  mocks.agentConversation.create.mockResolvedValue({ id: "conversation-1" })
  mocks.agentConversation.findFirst.mockResolvedValue({ id: "conversation-1", interviewProcessingJson: JSON.stringify({ status: "PENDING", interviewId: ids.interview }) })
  mocks.transaction.mockImplementation(async callback => callback({ pMInterview: mocks.pMInterview, agentConversation: mocks.agentConversation }))
  mocks.participantToken.findFirst.mockResolvedValue({ id: "internal-token-id", studyId: "study-1", kind: "PM_INTERNAL", tokenHash: "a".repeat(64) })
  mocks.respond.mockResolvedValue({ message: "What observation would challenge that?", replayed: false })
  mocks.complete.mockResolvedValue({ completed: true })
  mocks.pMInterview.updateMany.mockResolvedValue({ count: 1 })
  mocks.agent.mockResolvedValue(JSON.stringify({
    version: 1,
    brief: "The PM clarified the opportunity.",
    proposedFields: { title: { value: "New teams struggle to activate", transcriptTurnIds: [ids.turn] } },
    openQuestions: [],
    suggestedNextSteps: ["Interview a new team."],
    unknowns: [],
  }))
})

describe("authenticated PM interview transport", () => {
  it("responds through the shared session engine with only the bound internal token and PM context prompt", async () => {
    await expect(respondToPmInterview(scope, actor, ids.interview, {
      answer: "New teams lose their setup context.",
      idempotencyKey: "pm-respond-transport-0001",
    })).resolves.toMatchObject({ message: "What observation would challenge that?" })

    expect(mocks.participantToken.findFirst).toHaveBeenCalledWith({ where: { id: "internal-token-id", studyId: "study-1", kind: "PM_INTERNAL" } })
    const call = mocks.respond.mock.calls[0][0]
    expect(call.context.participantToken.kind).toBe("PM_INTERNAL")
    expect(call.buildPrompt({ defaultPrompt: "Interview rules" })).toContain("<untrusted_pm_item_context>")
    expect(call.buildPrompt({ defaultPrompt: "Interview rules" })).toContain("Never describe PM interpretation as customer evidence")
  })

  it("completes the canonical session before linking the core-agent conversation without generating a proposal", async () => {
    await expect(completePmInterview(scope, actor, ids.interview)).resolves.toMatchObject({
      conversationId: "conversation-1", conversationUrl: "/acme/product/agent?c=conversation-1", processingStatus: "PENDING",
    })
    expect(mocks.complete).toHaveBeenCalledOnce()
    expect(mocks.complete.mock.invocationCallOrder[0]).toBeLessThan(mocks.transaction.mock.invocationCallOrder[0])
    expect(mocks.agentConversation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ workspaceId: "workspace-1", userId: ids.owner }),
    }))
    expect(mocks.pMInterview.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: ids.interview, agentConversationId: null, disposition: "PENDING" },
      data: expect.objectContaining({ agentConversationId: "conversation-1", generationClaimId: null }),
    }))
    expect(mocks.agent).not.toHaveBeenCalled()
  })

  it("replays an already-linked conversation without completing or allocating another model call", async () => {
    mocks.pMInterview.findFirst.mockResolvedValue(interview({ agentConversationId: "conversation-1" }))
    await expect(completePmInterview(scope, actor, ids.interview)).resolves.toMatchObject({ conversationId: "conversation-1" })
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(mocks.agent).not.toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.pMInterview.updateMany).not.toHaveBeenCalled()
  })

  it("retains canonical completion after a handoff failure and retries linking without model generation", async () => {
    mocks.transaction.mockRejectedValueOnce(new Error("synthetic transaction failure"))
    await expect(completePmInterview(scope, actor, ids.interview)).rejects.toThrow("synthetic transaction failure")
    expect(mocks.complete).toHaveBeenCalledOnce()
    expect(mocks.pMInterview.updateMany).not.toHaveBeenCalled()
    mocks.pMInterview.findFirst.mockResolvedValue(interview({ session: { ...interview().session, status: "COMPLETED" } }))
    await expect(completePmInterview(scope, actor, ids.interview)).resolves.toMatchObject({ conversationId: "conversation-1" })
    expect(mocks.agentConversation.create).toHaveBeenCalledOnce()
    expect(mocks.agent).not.toHaveBeenCalled()
  })

  it("keeps a legacy ready proposal unchanged when Finish hands off to the core agent", async () => {
    const proposalJson = JSON.stringify({ brief: "Historical proposal" })
    const legacy = interview({ generationState: "READY", proposalJson })
    mocks.pMInterview.findFirst.mockResolvedValue(legacy)
    mocks.pMInterview.findUnique.mockResolvedValue(legacy)
    await expect(completePmInterview(scope, actor, ids.interview)).resolves.toMatchObject({ conversationId: "conversation-1" })
    expect(mocks.complete).toHaveBeenCalledOnce()
    expect(mocks.agent).not.toHaveBeenCalled()
    expect(mocks.pMInterview.updateMany.mock.calls[0][0].data).not.toHaveProperty("proposalJson")
    expect(legacy.proposalJson).toBe(proposalJson)
  })
})
