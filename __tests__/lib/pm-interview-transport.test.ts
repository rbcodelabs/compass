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
  pMInterview: { findFirst: vi.fn(), updateMany: vi.fn() },
  participantToken: { findFirst: vi.fn() },
}))

vi.mock("@/lib/db", () => ({ default: () => ({
  workspace: mocks.workspace,
  pMInterview: mocks.pMInterview,
  researchParticipantToken: mocks.participantToken,
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

  it("completes the canonical session before claiming generation from its reloaded transcript", async () => {
    const completed = interview({ session: { ...interview().session, status: "COMPLETED" } })
    mocks.pMInterview.findFirst.mockResolvedValueOnce(interview()).mockResolvedValue(completed)

    await expect(completePmInterview(scope, actor, ids.interview)).resolves.toMatchObject({
      brief: "The PM clarified the opportunity.",
      proposedFields: { title: { transcriptTurnIds: [ids.turn] } },
    })

    expect(mocks.complete).toHaveBeenCalledTimes(1)
    expect(mocks.complete.mock.invocationCallOrder[0]).toBeLessThan(mocks.pMInterview.updateMany.mock.invocationCallOrder[0])
    expect(mocks.pMInterview.updateMany.mock.calls[0][0]).toMatchObject({
      where: expect.objectContaining({ initiatingUserId: ids.owner }),
      data: expect.objectContaining({ generationState: "GENERATING", sourceFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    })
    expect(mocks.pMInterview.updateMany.mock.calls[1][0]).toMatchObject({
      where: expect.objectContaining({ generationState: "GENERATING" }),
      data: expect.objectContaining({ generationState: "READY" }),
    })
  })

  it("replays an already-ready proposal without completing or allocating another model call", async () => {
    const readyProposal = await mocks.agent()
    mocks.agent.mockClear()
    mocks.pMInterview.findFirst.mockResolvedValue(interview({ generationState: "READY", proposalJson: readyProposal }))

    await expect(completePmInterview(scope, actor, ids.interview)).resolves.toMatchObject({ brief: "The PM clarified the opportunity." })
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(mocks.agent).not.toHaveBeenCalled()
    expect(mocks.pMInterview.updateMany).not.toHaveBeenCalled()
  })

  it("preserves the transcript on generation failure and succeeds on an explicit retry", async () => {
    const completed = interview({ session: { ...interview().session, status: "COMPLETED" } })
    mocks.pMInterview.findFirst.mockResolvedValueOnce(interview()).mockResolvedValueOnce(completed)
    mocks.agent.mockRejectedValueOnce(new Error("synthetic provider failure"))

    await expect(completePmInterview(scope, actor, ids.interview)).rejects.toMatchObject({ status: 502 })
    expect(mocks.pMInterview.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ generationState: "FAILED", generationFailureCode: "GENERATION_FAILED" }),
    }))

    mocks.pMInterview.findFirst.mockReset()
    mocks.pMInterview.findFirst.mockResolvedValueOnce(interview({ generationState: "FAILED", session: { ...interview().session, status: "COMPLETED" } })).mockResolvedValueOnce(completed)
    mocks.agent.mockResolvedValueOnce(JSON.stringify({
      version: 1, brief: "Retry succeeded.",
      proposedFields: { title: { value: "New teams struggle to activate", transcriptTurnIds: [ids.turn] } },
      openQuestions: [], suggestedNextSteps: [], unknowns: [],
    }))

    await expect(completePmInterview(scope, actor, ids.interview)).resolves.toMatchObject({ brief: "Retry succeeded." })
    expect(mocks.pMInterview.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ generationState: "READY" }) }))
  })
})
