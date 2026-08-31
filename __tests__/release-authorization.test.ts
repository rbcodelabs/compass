import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const tx = {
    task: { findMany: vi.fn() },
    releaseRun: { findFirst: vi.fn(), create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    releaseRunTask: { createMany: vi.fn() },
    reviewRequest: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    reviewRevision: { create: vi.fn(), update: vi.fn() },
    decisionRecord: { findUnique: vi.fn() },
    decisionApplication: { findUnique: vi.fn(), create: vi.fn() },
    releaseDispatch: { findUnique: vi.fn(), create: vi.fn() },
  }
  return {
    tx,
    prisma: { ...tx, $transaction: vi.fn((fn: (value: typeof tx) => unknown) => fn(tx)) },
    recordDecision: vi.fn(),
  }
})

vi.mock("@/lib/db", () => ({ default: () => mocks.prisma }))
vi.mock("@/lib/decision-service", () => ({ recordDecision: mocks.recordDecision }))

import {
  prepareReleaseRun,
  queueAuthorizedRelease,
  recordReleaseDecision,
  releaseSourceFingerprint,
  type ReleaseScope,
  type ReleaseSourceRevalidator,
} from "@/lib/release-authorization"

const scope: ReleaseScope = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  provider: "GITHUB",
  repositoryOwner: "rbcodelabs",
  repositoryName: "compass",
  pullRequestNumber: 142,
  baseRef: "main",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  targetEnvironment: "PRODUCTION",
  releasePolicyId: "release-policy:v1:sha256:abc",
  taskIds: [
    "00000000-0000-4000-8000-000000000003",
    "00000000-0000-4000-8000-000000000002",
  ],
}

const sourceFingerprint = releaseSourceFingerprint(scope)
const validSource: ReleaseSourceRevalidator = {
  revalidate: vi.fn().mockResolvedValue({ status: "VALID", scope }),
}
const run = {
  id: "00000000-0000-4000-8000-000000000010",
  ...scope,
  taskIds: undefined,
  sourceFingerprint,
  state: "READY_FOR_APPROVAL",
  authorizationDecisionRecordId: null,
  version: 0,
  tasks: scope.taskIds.map((taskId) => ({ taskId })),
}
const approvingDecision = {
  id: "decision-1",
  workspaceId: scope.workspaceId,
  fingerprint: "review-fingerprint",
  revision: {
    fingerprint: "review-fingerprint",
    sourceFingerprint,
    supersededAt: null,
    request: { workspaceId: scope.workspaceId, subjectType: "RELEASE_RUN", subjectId: run.id, gateType: "RELEASE_AUTHORIZATION" },
  },
  option: { outcomeClass: "APPROVE", continuationKey: "DISPATCH_RELEASE_RUN" },
}

describe("release authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.prisma.$transaction.mockImplementation((fn: (value: typeof mocks.tx) => unknown) => fn(mocks.tx))
    vi.mocked(validSource.revalidate).mockResolvedValue({ status: "VALID", scope })
  })

  it("recovers the identical winner when concurrent preparation hits P2002", async () => {
    const winner = { ...run, tasks: scope.taskIds.map((taskId) => ({ taskId })) }
    const winnerRequest = {
      id: "request-winner",
      state: "PENDING",
      currentRevision: { id: "revision-winner", sourceFingerprint, fingerprint: "review-winner" },
    }
    mocks.prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }))
    mocks.prisma.releaseRun.findFirst.mockResolvedValue(winner)
    mocks.prisma.reviewRequest.findFirst.mockResolvedValue(winnerRequest)

    await expect(prepareReleaseRun(scope)).resolves.toEqual({
      status: "READY",
      releaseRunId: run.id,
      requestId: "request-winner",
      revisionId: "revision-winner",
      sourceFingerprint,
      reviewFingerprint: "review-winner",
    })
  })

  it("does not recover a P2002 winner with a different immutable identity", async () => {
    mocks.prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }))
    mocks.prisma.releaseRun.findFirst.mockResolvedValue({ ...run, headSha: "f".repeat(40), tasks: run.tasks })

    await expect(prepareReleaseRun(scope)).rejects.toThrow("different release identity")
  })

  it("hashes the exact release source scope with Task IDs sorted", () => {
    const canonical = JSON.stringify({
      workspaceId: scope.workspaceId,
      provider: scope.provider,
      repositoryOwner: scope.repositoryOwner,
      repositoryName: scope.repositoryName,
      pullRequestNumber: scope.pullRequestNumber,
      baseRef: scope.baseRef,
      headSha: scope.headSha,
      targetEnvironment: scope.targetEnvironment,
      releasePolicyId: scope.releasePolicyId,
      taskIds: [...scope.taskIds].sort(),
    })
    const expected = createHash("sha256").update(canonical).digest("hex")

    expect(releaseSourceFingerprint(scope)).toBe(expected)
    expect(releaseSourceFingerprint({ ...scope, taskIds: [...scope.taskIds].reverse() })).toBe(expected)

    for (const changed of [
      { ...scope, workspaceId: "00000000-0000-4000-8000-000000000099" },
      { ...scope, repositoryOwner: "other-owner" },
      { ...scope, repositoryName: "other-repo" },
      { ...scope, pullRequestNumber: 143 },
      { ...scope, baseRef: "release" },
      { ...scope, headSha: "1123456789abcdef0123456789abcdef01234567" },
      { ...scope, targetEnvironment: "STAGING" as ReleaseScope["targetEnvironment"] },
      { ...scope, releasePolicyId: "release-policy:v2" },
      { ...scope, taskIds: [scope.taskIds[0]] },
    ]) {
      expect(releaseSourceFingerprint(changed)).not.toBe(expected)
    }
  })

  it("prepares one normalized run and immutable release review for same-workspace Tasks", async () => {
    mocks.tx.task.findMany.mockResolvedValue(scope.taskIds.map((id) => ({ id })))
    mocks.tx.releaseRun.findFirst.mockResolvedValue(null)
    mocks.tx.releaseRun.create.mockResolvedValue({ id: run.id, version: 0 })
    mocks.tx.releaseRunTask.createMany.mockResolvedValue({ count: 2 })
    mocks.tx.reviewRequest.create.mockResolvedValue({ id: "request-1", revisionCount: 0, decisionCycle: 1 })
    mocks.tx.reviewRevision.create.mockImplementation(async ({ data }) => ({ id: "revision-1", ...data }))
    mocks.tx.reviewRequest.update.mockResolvedValue({})
    mocks.tx.releaseRun.updateMany.mockResolvedValue({ count: 1 })

    const result = await prepareReleaseRun({ ...scope, requestedById: "00000000-0000-4000-8000-000000000004" })

    expect(result).toEqual(expect.objectContaining({
      status: "READY",
      releaseRunId: run.id,
      requestId: "request-1",
      revisionId: "revision-1",
      sourceFingerprint,
      reviewFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    }))
    expect(mocks.tx.task.findMany).toHaveBeenCalledWith({
      where: { workspaceId: scope.workspaceId, id: { in: [...scope.taskIds].sort() } },
      select: { id: true },
    })
    expect(mocks.tx.releaseRunTask.createMany).toHaveBeenCalledWith({
      data: [...scope.taskIds].sort().map((taskId) => ({ releaseRunId: run.id, taskId })),
    })
    expect(mocks.tx.reviewRevision.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        sourceFingerprint,
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        requiredRole: "ADMIN",
        options: { create: expect.arrayContaining([
          expect.objectContaining({ actionKey: "APPROVE_RELEASE", label: "Approve & release", continuationKey: "DISPATCH_RELEASE_RUN" }),
        ]) },
      }),
    }))
  })

  it("blocks preparation when any covered Task is outside the workspace", async () => {
    mocks.tx.task.findMany.mockResolvedValue([{ id: scope.taskIds[0] }])

    await expect(prepareReleaseRun(scope)).resolves.toEqual({ status: "BLOCKED", code: "INVALID_TASK_SCOPE" })
    expect(mocks.tx.releaseRun.create).not.toHaveBeenCalled()
    expect(mocks.tx.reviewRevision.create).not.toHaveBeenCalled()
  })

  it("records the human response through the shared decision service", async () => {
    const input = {
      actor: { kind: "USER" as const, userId: "user-1" },
      revisionId: "revision-1",
      fingerprint: "review-fingerprint",
      optionId: "option-1",
      rationale: "Checks are green",
      idempotencyKey: "release-decision-1",
    }
    mocks.recordDecision.mockResolvedValue({ id: "decision-1" })

    await expect(recordReleaseDecision(input)).resolves.toEqual({ id: "decision-1" })
    expect(mocks.recordDecision).toHaveBeenCalledWith(input)
  })

  it("queues one durable dispatch and application in the same transaction", async () => {
    mocks.tx.releaseDispatch.findUnique.mockResolvedValue(null)
    mocks.tx.releaseRun.findUnique.mockResolvedValue(run)
    mocks.tx.decisionRecord.findUnique.mockResolvedValue(approvingDecision)
    mocks.tx.decisionApplication.findUnique.mockResolvedValue(null)
    mocks.tx.releaseRun.updateMany.mockResolvedValue({ count: 1 })
    mocks.tx.decisionApplication.create.mockResolvedValue({ id: "application-1" })
    mocks.tx.releaseDispatch.create.mockResolvedValue({ id: "dispatch-1", status: "PENDING" })

    await expect(queueAuthorizedRelease(run.id, "decision-1", sourceFingerprint, validSource))
      .resolves.toEqual({ status: "QUEUED", dispatchId: "dispatch-1" })

    expect(mocks.prisma.$transaction).toHaveBeenCalledOnce()
    expect(mocks.tx.releaseRun.updateMany).toHaveBeenCalledWith({
      where: { id: run.id, version: 0, authorizationDecisionRecordId: null },
      data: expect.objectContaining({ authorizationDecisionRecordId: "decision-1", state: "DISPATCH_QUEUED", version: 1 }),
    })
    expect(mocks.tx.decisionApplication.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        decisionId: "decision-1",
        continuationKey: "DISPATCH_RELEASE_RUN",
        targetType: "RELEASE_RUN",
        targetId: run.id,
        status: "APPLIED",
      }),
    })
    expect(mocks.tx.releaseDispatch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        releaseRunId: run.id,
        decisionRecordId: "decision-1",
        continuationKey: "DISPATCH_RELEASE_RUN",
        status: "PENDING",
      }),
    })
  })

  it("rejects changed release scope before creating an outbox row", async () => {
    mocks.tx.releaseDispatch.findUnique.mockResolvedValue(null)
    mocks.tx.releaseRun.findUnique.mockResolvedValue({ ...run, headSha: "1123456789abcdef0123456789abcdef01234567" })

    await expect(queueAuthorizedRelease(run.id, "decision-1", sourceFingerprint, validSource))
      .resolves.toEqual({ status: "BLOCKED", code: "STALE_SOURCE" })
    expect(mocks.tx.decisionApplication.create).not.toHaveBeenCalled()
    expect(mocks.tx.releaseDispatch.create).not.toHaveBeenCalled()
  })

  it("does not authorize a run that is no longer ready for approval", async () => {
    mocks.tx.releaseDispatch.findUnique.mockResolvedValue(null)
    mocks.tx.releaseRun.findUnique.mockResolvedValue({ ...run, state: "BLOCKED" })

    await expect(queueAuthorizedRelease(run.id, "decision-1", sourceFingerprint, validSource))
      .resolves.toEqual({ status: "BLOCKED", code: "STALE_SOURCE" })
    expect(mocks.tx.decisionRecord.findUnique).not.toHaveBeenCalled()
    expect(mocks.tx.releaseDispatch.create).not.toHaveBeenCalled()
  })

  it("returns the existing dispatch without repeating authorization writes", async () => {
    mocks.tx.releaseDispatch.findUnique.mockResolvedValue({
      id: "dispatch-existing",
      releaseRunId: run.id,
      decisionRecordId: "decision-1",
    })

    await expect(queueAuthorizedRelease(run.id, "decision-1", sourceFingerprint, validSource))
      .resolves.toEqual({ status: "EXISTING", dispatchId: "dispatch-existing" })
    expect(mocks.tx.releaseRun.findUnique).not.toHaveBeenCalled()
    expect(mocks.tx.releaseRun.updateMany).not.toHaveBeenCalled()
    expect(mocks.tx.decisionApplication.create).not.toHaveBeenCalled()
    expect(mocks.tx.releaseDispatch.create).not.toHaveBeenCalled()
  })

  for (const code of ["PR_NOT_READY", "CHECKS_FAILED", "POLICY_CHANGED"] as const) {
    it(`fails closed and supersedes the stale authorization when revalidation reports ${code}`, async () => {
      const revalidator: ReleaseSourceRevalidator = {
        revalidate: vi.fn().mockResolvedValue({ status: "BLOCKED", code }),
      }
      mocks.tx.releaseDispatch.findUnique.mockResolvedValue(null)
      mocks.tx.releaseRun.findUnique.mockResolvedValue(run)
      mocks.tx.decisionRecord.findUnique.mockResolvedValue(approvingDecision)
      mocks.tx.reviewRequest.findFirst.mockResolvedValue({ id: "request-1", currentRevisionId: "revision-1" })
      mocks.tx.reviewRevision.update.mockResolvedValue({})
      mocks.tx.reviewRequest.update.mockResolvedValue({})
      mocks.tx.releaseRun.updateMany.mockResolvedValue({ count: 1 })

      await expect(queueAuthorizedRelease(run.id, "decision-1", sourceFingerprint, revalidator))
        .resolves.toEqual({ status: "BLOCKED", code })

      expect(mocks.tx.reviewRevision.update).toHaveBeenCalledWith({
        where: { id: "revision-1" }, data: { supersededAt: expect.any(Date) },
      })
      expect(mocks.tx.reviewRequest.update).toHaveBeenCalledWith({
        where: { id: "request-1" }, data: { state: "SUPERSEDED", updatedAt: expect.any(Date) },
      })
      expect(mocks.tx.releaseRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: run.id, version: run.version },
        data: expect.objectContaining({ state: "SUPERSEDED", lastErrorCode: code }),
      }))
      expect(mocks.tx.releaseDispatch.create).not.toHaveBeenCalled()
    })
  }
})
