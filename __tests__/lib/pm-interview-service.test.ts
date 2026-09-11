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
  readPmInterview,
  settlePmInterviewVoice,
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
    transitionReceiptJson: null,
    retiredVoiceLeaseId: null,
    contextSnapshotJson: JSON.stringify({ version: 1, capturedAt: "2026-09-11T12:00:00.000Z", target: { type: "OPPORTUNITY", id: targetId, fields: { title: "Original", description: "Original description", customerSegment: null } }, parents: [], outcome: null, evidence: [], feedback: [], omissions: [] }),
    createdAt: new Date("2026-09-11T11:00:00Z"),
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

  it("returns complete safe applied history to a non-owner member", async () => {
    const otherOwner = "00000000-0000-4000-8000-000000000099"
    mocks.prisma.pMInterview.findFirst.mockResolvedValue(interview({
      initiatingUserId: otherOwner,
      disposition: "APPLIED",
      receiptJson: JSON.stringify({ version: 1, kind: "APPLIED", idempotencyKey: "safe-read-apply-0001", requestFingerprint: "a".repeat(64), actorUserId: otherOwner, selectedFields: ["title"], before: { title: "Original" }, after: { title: "Applied" }, at: "2026-09-11T12:05:00.000Z" }),
      session: { id: sessionId, status: "COMPLETED", modality: "CHAT", participantTokenId: "secret-token", resumeTokenHash: "secret-hash", voiceLeaseId: "secret-lease", turns: [
        { id: "00000000-0000-4000-8000-000000000060", role: "PARTICIPANT", content: "Complete answer", sequence: 1, createdAt: new Date("2026-09-11T12:01:00Z") },
        { id: "00000000-0000-4000-8000-000000000061", role: "INTERVIEWER", content: "Complete follow-up", sequence: 2, createdAt: new Date("2026-09-11T12:02:00Z") },
      ] },
    }))

    const result = await readPmInterview(scope, actor, interviewId)
    expect(result).toMatchObject({ owner: false, disposition: "APPLIED", receipt: { version: 1, kind: "APPLIED", selectedFields: ["title"], before: { title: "Original" }, after: { title: "Applied" } } })
    expect(result.session.turns.map(turn => turn.content)).toEqual(["Complete answer", "Complete follow-up"])
    expect(JSON.stringify(result)).not.toContain("secret-")
  })

  it("returns history with an application-disabled reason after target deletion", async () => {
    mocks.prisma.opportunity.findFirst.mockResolvedValue(null)
    await expect(readPmInterview(scope, actor, interviewId)).resolves.toMatchObject({ applicationDisabledReason: "The source item was deleted; interview history remains readable." })
  })

  it("rechecks membership before non-owner history reads", async () => {
    mocks.prisma.workspace.findFirst.mockResolvedValue(null)
    await expect(readPmInterview(scope, actor, interviewId)).rejects.toMatchObject({ status: 404 })
    expect(mocks.prisma.pMInterview.findFirst).not.toHaveBeenCalled()
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

  it("throws after the target write when receipt finalization loses its CAS so the database transaction rolls back", async () => {
    mocks.prisma.pMInterview.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })

    await expect(applyPmInterview(scope, actor, interviewId, {
      selectedFields: ["title"], idempotencyKey: "apply-finalization-rollback-0001",
    })).rejects.toMatchObject({ status: 409 })

    expect(mocks.prisma.opportunity.update).toHaveBeenCalledTimes(1)
    expect(mocks.prisma.pMInterview.updateMany).toHaveBeenCalledTimes(2)
    expect(mocks.prisma.pMInterview.updateMany.mock.invocationCallOrder[1]).toBeGreaterThan(mocks.prisma.opportunity.update.mock.invocationCallOrder[0])
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
    mocks.prisma.researchSession.findFirst.mockResolvedValue({ id: sessionId, voiceLeaseId: leaseId, updatedAt: new Date("2026-09-11T12:00:00Z") })
  })

  it("records an exact-lease finalized settlement before transition", async () => {
    mocks.prisma.researchParticipantVoiceEvent.findMany.mockResolvedValue([{ reportedOrdinal: 2 }, { reportedOrdinal: 3 }])

    await expect(settlePmInterviewVoice(scope, actor, interviewId, { leaseId, settlement: "FINALIZED" })).resolves.toMatchObject({ phase: "SETTLED", settlement: "FINALIZED" })

    const settlement = JSON.parse(mocks.prisma.pMInterview.updateMany.mock.calls[0][0].data.transitionReceiptJson)
    expect(settlement).toMatchObject({ version: 1, phase: "SETTLED", leaseId, settlement: "FINALIZED", finalizedEventCount: 2, lastFinalizedOrdinal: 3 })
  })

  it("advances the settlement session fence even within the same clock millisecond", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-09-11T12:00:00.000Z"))
    try {
      await settlePmInterviewVoice(scope, actor, interviewId, { leaseId, settlement: "FINALIZED" })
      expect(mocks.prisma.researchSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ updatedAt: new Date("2026-09-11T12:00:00.001Z") }) }))
    } finally { vi.useRealTimers() }
  })

  it("does not record settlement when a concurrent final event wins the shared session fence", async () => {
    mocks.prisma.researchSession.updateMany.mockResolvedValue({ count: 0 })
    await expect(settlePmInterviewVoice(scope, actor, interviewId, { leaseId, settlement: "FINALIZED" })).rejects.toMatchObject({ status: 409 })
    expect(mocks.prisma.pMInterview.updateMany).not.toHaveBeenCalled()
  })

  it("maps a DSQL settlement serialization race to a retryable conflict", async () => {
    mocks.prisma.$transaction.mockRejectedValueOnce({ code: "P2034" })
    await expect(settlePmInterviewVoice(scope, actor, interviewId, { leaseId, settlement: "FINALIZED" })).rejects.toMatchObject({ status: 409 })
  })

  it("rejects a direct finalized transition until the exact lease settlement is proven", async () => {
    await expect(switchPmInterviewToText(scope, actor, interviewId, { leaseId, settlement: "FINALIZED" })).rejects.toMatchObject({ status: 409 })
    expect(mocks.prisma.researchSession.updateMany).not.toHaveBeenCalled()
  })

  it("retires only the exact settled lease and records the completed transition atomically", async () => {
    mocks.prisma.researchParticipantVoiceEvent.findMany.mockResolvedValue([{ reportedOrdinal: 2 }, { reportedOrdinal: 3 }])
    mocks.prisma.pMInterview.findFirst.mockReset()
    mocks.prisma.pMInterview.findFirst.mockResolvedValueOnce(interview({
      transitionReceiptJson: JSON.stringify({ version: 1, phase: "SETTLED", leaseId, settlement: "FINALIZED", finalizedEventCount: 2, lastFinalizedOrdinal: 3, at: "2026-09-11T12:00:00.000Z" }),
      session: { id: sessionId, status: "IN_PROGRESS", modality: "VOICE", participantTokenId: "token-1", voiceLeaseId: leaseId, turns: [] },
    })).mockResolvedValue({ id: interviewId, sessionId, transitionReceiptJson: JSON.stringify({ version: 1, phase: "SETTLED", leaseId, settlement: "FINALIZED", finalizedEventCount: 2, lastFinalizedOrdinal: 3, at: "2026-09-11T12:00:00.000Z" }) })

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
    expect(transition).toMatchObject({ phase: "TRANSITIONED", leaseId, settlement: "FINALIZED", finalizedEventCount: 2, lastFinalizedOrdinal: 3 })
  })

  it("blocks unconfirmed pending speech unless the PM explicitly discards it", async () => {
    mocks.prisma.researchVoiceCall.findFirst.mockResolvedValue({ id: "call-1", transcriptIntegrity: "PENDING" })

    await expect(settlePmInterviewVoice(scope, actor, interviewId, { leaseId, settlement: "FINALIZED" })).rejects.toMatchObject({ status: 409 })
    expect(mocks.prisma.pMInterview.update).not.toHaveBeenCalled()

    mocks.prisma.pMInterview.findFirst.mockReset()
    mocks.prisma.pMInterview.findFirst.mockResolvedValueOnce(interview({
      session: { id: sessionId, status: "IN_PROGRESS", modality: "VOICE", participantTokenId: "token-1", voiceLeaseId: leaseId, turns: [] },
    })).mockResolvedValue({ id: interviewId, sessionId, transitionReceiptJson: null })
    await expect(settlePmInterviewVoice(scope, actor, interviewId, { leaseId, settlement: "DISCARD_PENDING" })).resolves.toMatchObject({ phase: "SETTLED", settlement: "DISCARD_PENDING" })
    const receipt = JSON.parse(mocks.prisma.pMInterview.updateMany.mock.calls.at(-1)![0].data.transitionReceiptJson)
    expect(receipt).toMatchObject({ phase: "SETTLED", settlement: "DISCARD_PENDING" })
    expect(receipt).not.toHaveProperty("transcriptComplete", true)

    mocks.prisma.pMInterview.findFirst.mockReset()
    mocks.prisma.pMInterview.findFirst.mockResolvedValueOnce(interview({ transitionReceiptJson: JSON.stringify(receipt),
      session: { id: sessionId, status: "IN_PROGRESS", modality: "VOICE", participantTokenId: "token-1", voiceLeaseId: leaseId, turns: [] },
    })).mockResolvedValue({ id: interviewId, sessionId, transitionReceiptJson: JSON.stringify(receipt) })
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
