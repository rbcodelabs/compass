import { beforeEach, describe, expect, it, vi } from "vitest"

const targetId = "00000000-0000-4000-8000-000000000010"
const interviewId = "00000000-0000-4000-8000-000000000020"
const sessionId = "00000000-0000-4000-8000-000000000030"
const ownerId = "00000000-0000-4000-8000-000000000040"
const leaseId = "00000000-0000-4000-8000-000000000050"

const mocks = vi.hoisted(() => {
  const workspace = { findFirst: vi.fn() }
  const pMInterview = { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() }
  const opportunity = { findFirst: vi.fn(), update: vi.fn() }
  const solution = { findFirst: vi.fn(), update: vi.fn() }
  const assumption = { findFirst: vi.fn(), update: vi.fn() }
  const experiment = { findFirst: vi.fn(), update: vi.fn() }
  const workspaceMember = { findFirst: vi.fn() }
  const researchSession = { findFirst: vi.fn(), updateMany: vi.fn() }
  const researchParticipantVoiceEvent = { findMany: vi.fn() }
  const researchVoiceCall = { findFirst: vi.fn(), update: vi.fn() }
  const prisma = {
    workspace, pMInterview, opportunity, solution, assumption, experiment,
    workspaceMember, researchSession, researchParticipantVoiceEvent, researchVoiceCall,
    $transaction: vi.fn(),
  }
  return { prisma }
})

vi.mock("@/lib/db", () => ({ default: () => mocks.prisma }))

import {
  acknowledgePmInterviewBaseline,
  applyPmInterview,
  switchPmInterviewToText,
} from "@/lib/pm-interview-service"

const scope = { orgSlug: "acme", workspaceSlug: "product" }
const actor = { userId: ownerId }

function proposal(fields: Record<string, string | null>) {
  return JSON.stringify({
    version: 1,
    brief: "The PM clarified the item.",
    proposedFields: Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, { value, transcriptTurnIds: [] }])),
    openQuestions: [],
    suggestedNextSteps: [],
    unknowns: [],
  })
}

function interview(overrides: Record<string, unknown> = {}) {
  return {
    id: interviewId,
    workspaceId: "workspace-1",
    studyId: "study-1",
    sessionId,
    initiatingUserId: ownerId,
    targetType: "OPPORTUNITY",
    targetId,
    fieldBaselineJson: JSON.stringify({ version: 1, fields: { title: "Original", description: "Original description", customerSegment: null } }),
    proposalJson: proposal({ title: "Generated", description: "Generated description" }),
    generationState: "READY",
    generationFailureCode: null,
    disposition: "PENDING",
    dispositionIdempotencyKey: null,
    receiptJson: null,
    updatedAt: new Date("2026-09-11T12:00:00Z"),
    session: { id: sessionId, status: "IN_PROGRESS", modality: "CHAT", participantTokenId: "token-1", voiceLeaseId: null, turns: [] },
    study: { id: "study-1", studyType: "PM_INTERVIEW" },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.prisma.workspace.findFirst.mockResolvedValue({ id: "workspace-1" })
  mocks.prisma.pMInterview.findFirst.mockResolvedValue(interview())
  mocks.prisma.pMInterview.findUnique.mockResolvedValue(interview())
  mocks.prisma.workspaceMember.findFirst.mockResolvedValue({ id: "member-1" })
  mocks.prisma.opportunity.findFirst.mockResolvedValue({
    id: targetId,
    workspaceId: "workspace-1",
    title: "Original",
    description: "Original description",
    customerSegment: null,
    status: "EXPLORING",
  })
  mocks.prisma.opportunity.update.mockResolvedValue({ id: targetId })
  mocks.prisma.pMInterview.update.mockResolvedValue({ id: interviewId })
  mocks.prisma.pMInterview.updateMany.mockResolvedValue({ count: 1 })
  mocks.prisma.researchSession.updateMany.mockResolvedValue({ count: 1 })
  mocks.prisma.researchParticipantVoiceEvent.findMany.mockResolvedValue([])
  mocks.prisma.researchVoiceCall.findFirst.mockResolvedValue(null)
  mocks.prisma.$transaction.mockImplementation(async (operation: unknown) => {
    if (typeof operation === "function") return operation(mocks.prisma)
    return Promise.all(operation as Promise<unknown>[])
  })
})

describe("PM interview application fences", () => {
  it("authorizes current workspace membership before opening an apply transaction", async () => {
    mocks.prisma.workspace.findFirst.mockResolvedValue(null)

    await expect(applyPmInterview(scope, actor, interviewId, {
      selectedFields: ["title"], idempotencyKey: "apply-no-membership-0001",
    })).rejects.toMatchObject({ status: 404 })

    expect(mocks.prisma.pMInterview.findFirst).not.toHaveBeenCalled()
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled()
  })

  it("lets members read history but keeps apply owner-only", async () => {
    mocks.prisma.pMInterview.findFirst.mockResolvedValue(interview({ initiatingUserId: "00000000-0000-4000-8000-000000000099" }))

    await expect(applyPmInterview(scope, actor, interviewId, {
      selectedFields: ["title"], idempotencyKey: "apply-not-owner-0001",
    })).rejects.toMatchObject({ status: 404 })

    expect(mocks.prisma.$transaction).not.toHaveBeenCalled()
  })

  it("detects exact field drift even when the target timestamp did not change", async () => {
    mocks.prisma.opportunity.findFirst.mockResolvedValue({
      id: targetId,
      workspaceId: "workspace-1",
      title: "Changed through a legacy path",
      description: "Original description",
      customerSegment: null,
      status: "EXPLORING",
      updatedAt: new Date("2026-09-11T12:00:00Z"),
    })

    await expect(applyPmInterview(scope, actor, interviewId, {
      selectedFields: ["title"],
      editedValues: { title: "PM edit" },
      idempotencyKey: "apply-stale-baseline-0001",
    })).rejects.toMatchObject({ status: 409 })

    expect(mocks.prisma.opportunity.update).not.toHaveBeenCalled()
    expect(mocks.prisma.pMInterview.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: interviewId },
      data: expect.objectContaining({ generationState: "STALE", generationFailureCode: "BASELINE_CHANGED" }),
    }))
  })

  it("returns an exact idempotent apply receipt without touching the target again", async () => {
    const first = interview()
    const request = { selectedFields: ["title"], editedValues: { title: "PM edit" } }
    const { resolvePmInterviewApplyInput, parsePmInterviewProposal } = await import("@/lib/pm-interview-contracts")
    const resolved = resolvePmInterviewApplyInput("OPPORTUNITY", parsePmInterviewProposal(first.proposalJson!, "OPPORTUNITY"), request)
    const receipt = {
      version: 1,
      kind: "APPLIED",
      idempotencyKey: "apply-idempotent-0001",
      requestFingerprint: resolved.requestFingerprint,
      actorUserId: ownerId,
      selectedFields: ["title"],
      before: { title: "Original" },
      after: { title: "PM edit" },
      at: "2026-09-11T12:05:00Z",
    }
    mocks.prisma.pMInterview.findUnique.mockResolvedValue({
      ...first,
      disposition: "APPLIED",
      dispositionIdempotencyKey: receipt.idempotencyKey,
      receiptJson: JSON.stringify(receipt),
    })

    await expect(applyPmInterview(scope, actor, interviewId, { ...request, idempotencyKey: receipt.idempotencyKey })).resolves.toEqual(receipt)
    expect(mocks.prisma.opportunity.findFirst).not.toHaveBeenCalled()
    expect(mocks.prisma.opportunity.update).not.toHaveBeenCalled()
  })

  it("rejects a deleted target without reserving or applying anything", async () => {
    mocks.prisma.opportunity.findFirst.mockResolvedValue(null)

    await expect(applyPmInterview(scope, actor, interviewId, {
      selectedFields: ["title"], idempotencyKey: "apply-deleted-target-0001",
    })).rejects.toMatchObject({ status: 409 })

    expect(mocks.prisma.opportunity.update).not.toHaveBeenCalled()
    expect(mocks.prisma.pMInterview.updateMany).not.toHaveBeenCalled()
  })

  it("rechecks experiment lifecycle inside the write transaction", async () => {
    mocks.prisma.pMInterview.findFirst.mockResolvedValue(interview({
      targetType: "EXPERIMENT",
      fieldBaselineJson: JSON.stringify({ version: 1, fields: { title: "Original", hypothesis: "Prediction", method: "Method", killCondition: "Stop" } }),
      proposalJson: proposal({ title: "Generated" }),
    }))
    mocks.prisma.pMInterview.findUnique.mockResolvedValue(interview({ targetType: "EXPERIMENT" }))
    mocks.prisma.experiment.findFirst.mockResolvedValue({ id: targetId, workspaceId: "workspace-1", title: "Original", hypothesis: "Prediction", method: "Method", killCondition: "Stop", status: "RUNNING" })

    await expect(applyPmInterview(scope, actor, interviewId, {
      selectedFields: ["title"], idempotencyKey: "apply-running-experiment-0001",
    })).rejects.toMatchObject({ status: 409 })

    expect(mocks.prisma.experiment.update).not.toHaveBeenCalled()
  })

  it("does not finalize a receipt when the target write fails", async () => {
    mocks.prisma.opportunity.update.mockRejectedValue(new Error("target write rolled back"))

    await expect(applyPmInterview(scope, actor, interviewId, {
      selectedFields: ["title"], idempotencyKey: "apply-rollback-0001",
    })).rejects.toThrow("target write rolled back")

    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(mocks.prisma.pMInterview.updateMany).toHaveBeenCalledTimes(1)
    expect(mocks.prisma.pMInterview.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ disposition: "PENDING" }),
      data: expect.not.objectContaining({ disposition: "APPLIED" }),
    }))
  })

  it("maps a lost apply reservation to a refreshable conflict without writing the target", async () => {
    mocks.prisma.pMInterview.updateMany.mockResolvedValueOnce({ count: 0 })

    await expect(applyPmInterview(scope, actor, interviewId, {
      selectedFields: ["title"], idempotencyKey: "apply-concurrent-reservation-0001",
    })).rejects.toMatchObject({ status: 409 })

    expect(mocks.prisma.opportunity.update).not.toHaveBeenCalled()
  })

  it("requires the refreshed baseline to remain exact before review acknowledgement", async () => {
    mocks.prisma.pMInterview.findFirst.mockResolvedValue(interview({ generationState: "STALE" }))
    mocks.prisma.opportunity.findFirst.mockResolvedValue({ id: targetId, title: "Changed again", description: "Original description", customerSegment: null })

    await expect(acknowledgePmInterviewBaseline(scope, actor, interviewId)).rejects.toMatchObject({ status: 409 })
    expect(mocks.prisma.pMInterview.updateMany).not.toHaveBeenCalled()
  })
})

describe("PM interview voice-to-text transaction", () => {
  beforeEach(() => {
    mocks.prisma.pMInterview.findFirst.mockResolvedValue(interview({
      session: { id: sessionId, status: "IN_PROGRESS", modality: "VOICE", participantTokenId: "token-1", voiceLeaseId: leaseId, turns: [] },
    }))
    mocks.prisma.pMInterview.findFirst.mockResolvedValueOnce(interview({
      session: { id: sessionId, status: "IN_PROGRESS", modality: "VOICE", participantTokenId: "token-1", voiceLeaseId: leaseId, turns: [] },
    })).mockResolvedValue({ id: interviewId, sessionId })
    mocks.prisma.researchSession.findFirst.mockResolvedValue({ id: sessionId, voiceLeaseId: leaseId })
  })

  it("retires only the exact active lease and records finalized event settlement atomically", async () => {
    mocks.prisma.researchParticipantVoiceEvent.findMany.mockResolvedValue([{ reportedOrdinal: 2 }, { reportedOrdinal: 3 }])

    await expect(switchPmInterviewToText(scope, actor, interviewId, { leaseId, settlement: "FINALIZED" })).resolves.toEqual({ modality: "CHAT", replayed: false })

    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(mocks.prisma.researchSession.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ modality: "VOICE", voiceLeaseId: leaseId }) }))
    expect(mocks.prisma.researchSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ modality: "VOICE", voiceLeaseId: leaseId }),
      data: expect.objectContaining({ modality: "CHAT", voiceLeaseId: null }),
    }))
    expect(mocks.prisma.pMInterview.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ retiredVoiceLeaseId: leaseId }),
    }))
    const transition = JSON.parse(mocks.prisma.pMInterview.update.mock.calls[0][0].data.transitionReceiptJson)
    expect(transition).toMatchObject({ settlement: "FINALIZED", finalizedEventCount: 2, lastFinalizedOrdinal: 3 })
  })

  it("blocks unconfirmed pending speech unless the PM explicitly discards it", async () => {
    mocks.prisma.researchVoiceCall.findFirst.mockResolvedValue({ id: "call-1", transcriptIntegrity: "PENDING" })

    await expect(switchPmInterviewToText(scope, actor, interviewId, { leaseId, settlement: "FINALIZED" })).rejects.toMatchObject({ status: 409 })
    expect(mocks.prisma.researchSession.updateMany).not.toHaveBeenCalled()

    mocks.prisma.pMInterview.findFirst.mockReset()
    mocks.prisma.pMInterview.findFirst.mockResolvedValueOnce(interview({
      session: { id: sessionId, status: "IN_PROGRESS", modality: "VOICE", participantTokenId: "token-1", voiceLeaseId: leaseId, turns: [] },
    })).mockResolvedValue({ id: interviewId, sessionId })
    await expect(switchPmInterviewToText(scope, actor, interviewId, { leaseId, settlement: "DISCARD_PENDING" })).resolves.toEqual({ modality: "CHAT", replayed: false })
    expect(mocks.prisma.researchVoiceCall.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ endReason: "SWITCH_TO_TEXT_DISCARD" }) }))
  })

  it("rejects a stale lease before changing session modality", async () => {
    mocks.prisma.researchSession.findFirst.mockResolvedValue(null)

    await expect(switchPmInterviewToText(scope, actor, interviewId, { leaseId, settlement: "FINALIZED" })).rejects.toMatchObject({ status: 409 })
    expect(mocks.prisma.researchSession.updateMany).not.toHaveBeenCalled()
    expect(mocks.prisma.pMInterview.update).not.toHaveBeenCalled()
  })
})
