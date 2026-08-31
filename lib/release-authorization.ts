import { createHash } from "node:crypto"
import getPrisma from "@/lib/db"
import { recordDecision } from "@/lib/decision-service"

const RELEASE_CONTINUATION = "DISPATCH_RELEASE_RUN" as const

export type ReleaseScope = {
  workspaceId: string
  provider: "GITHUB"
  repositoryOwner: string
  repositoryName: string
  pullRequestNumber: number
  baseRef: string
  headSha: string
  targetEnvironment: "PRODUCTION"
  releasePolicyId: string
  taskIds: string[]
}

type PrepareReleaseInput = ReleaseScope & { requestedById?: string | null }

export type PrepareReleaseResult =
  | {
      status: "READY"
      releaseRunId: string
      requestId: string
      revisionId: string
      sourceFingerprint: string
      reviewFingerprint: string
    }
  | { status: "BLOCKED"; code: "INVALID_TASK_SCOPE" | "PR_NOT_READY" | "CHECKS_FAILED" | "POLICY_CHANGED" }

export type QueueReleaseResult =
  | { status: "QUEUED" | "EXISTING"; dispatchId: string }
  | { status: "BLOCKED"; code: "STALE_SOURCE" | "REVOKED" | "DECISION_SCOPE_MISMATCH" | "RETRYABLE_CONFLICT" }

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function sortedTaskIds(taskIds: readonly string[]): string[] {
  return [...taskIds].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
}

export function releaseSourceFingerprint(scope: ReleaseScope): string {
  return sha256(JSON.stringify({
    workspaceId: scope.workspaceId,
    provider: scope.provider,
    repositoryOwner: scope.repositoryOwner,
    repositoryName: scope.repositoryName,
    pullRequestNumber: scope.pullRequestNumber,
    baseRef: scope.baseRef,
    headSha: scope.headSha,
    targetEnvironment: scope.targetEnvironment,
    releasePolicyId: scope.releasePolicyId,
    taskIds: sortedTaskIds(scope.taskIds),
  }))
}

export function releaseReviewFingerprint(input: {
  requestId: string
  decisionCycle: number
  revisionNumber: number
  sourceFingerprint: string
}): string {
  return sha256(`${input.requestId}:${input.decisionCycle}:${input.revisionNumber}:${input.sourceFingerprint}`)
}

function hasValidReleaseScope(scope: ReleaseScope): boolean {
  return scope.provider === "GITHUB"
    && scope.targetEnvironment === "PRODUCTION"
    && scope.repositoryOwner.trim().length > 0
    && scope.repositoryName.trim().length > 0
    && scope.baseRef.trim().length > 0
    && scope.releasePolicyId.trim().length > 0
    && Number.isSafeInteger(scope.pullRequestNumber)
    && scope.pullRequestNumber > 0
    && /^[a-f0-9]{40}$/i.test(scope.headSha)
    && scope.taskIds.length > 0
    && new Set(scope.taskIds).size === scope.taskIds.length
}

function decisionCycleOf(request: object): number {
  const value = (request as { decisionCycle?: unknown }).decisionCycle
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 1
}

export async function prepareReleaseRun(input: PrepareReleaseInput): Promise<PrepareReleaseResult> {
  if (!hasValidReleaseScope(input)) return { status: "BLOCKED", code: "INVALID_TASK_SCOPE" }

  const prisma = getPrisma()
  const taskIds = sortedTaskIds(input.taskIds)
  const sourceFingerprint = releaseSourceFingerprint({ ...input, taskIds })

  return prisma.$transaction(async (tx): Promise<PrepareReleaseResult> => {
    const coveredTasks = await tx.task.findMany({
      where: { workspaceId: input.workspaceId, id: { in: taskIds } },
      select: { id: true },
    })
    if (coveredTasks.length !== taskIds.length) return { status: "BLOCKED", code: "INVALID_TASK_SCOPE" }

    let releaseRun = await tx.releaseRun.findFirst({
      where: {
        workspaceId: input.workspaceId,
        provider: input.provider,
        repositoryOwner: input.repositoryOwner,
        repositoryName: input.repositoryName,
        pullRequestNumber: input.pullRequestNumber,
        sourceFingerprint,
      },
    })

    const existingRequest = releaseRun
      ? await tx.reviewRequest.findFirst({
          where: {
            workspaceId: input.workspaceId,
            gateType: "RELEASE_AUTHORIZATION",
            subjectType: "RELEASE_RUN",
            subjectId: releaseRun.id,
          },
          include: { currentRevision: true },
        })
      : null

    if (existingRequest?.state === "PENDING"
      && existingRequest.currentRevision?.sourceFingerprint === sourceFingerprint) {
      return {
        status: "READY",
        releaseRunId: releaseRun!.id,
        requestId: existingRequest.id,
        revisionId: existingRequest.currentRevision.id,
        sourceFingerprint,
        reviewFingerprint: existingRequest.currentRevision.fingerprint,
      }
    }
    if (existingRequest?.currentRevisionId) return { status: "BLOCKED", code: "PR_NOT_READY" }

    if (!releaseRun) {
      releaseRun = await tx.releaseRun.create({
        data: {
          workspaceId: input.workspaceId,
          provider: input.provider,
          repositoryOwner: input.repositoryOwner,
          repositoryName: input.repositoryName,
          pullRequestNumber: input.pullRequestNumber,
          baseRef: input.baseRef,
          headSha: input.headSha,
          targetEnvironment: input.targetEnvironment,
          releasePolicyId: input.releasePolicyId,
          sourceFingerprint,
          state: "PREPARING",
          createdById: input.requestedById ?? null,
        },
      })
      await tx.releaseRunTask.createMany({
        data: taskIds.map((taskId) => ({ releaseRunId: releaseRun!.id, taskId })),
      })
    }

    const request = existingRequest ?? await tx.reviewRequest.create({
      data: {
        workspaceId: input.workspaceId,
        gateType: "RELEASE_AUTHORIZATION",
        subjectType: "RELEASE_RUN",
        subjectId: releaseRun.id,
        state: "DRAFT",
        requestedById: input.requestedById ?? null,
      },
    })
    const revisionNumber = request.revisionCount + 1
    const reviewFingerprint = releaseReviewFingerprint({
      requestId: request.id,
      decisionCycle: decisionCycleOf(request),
      revisionNumber,
      sourceFingerprint,
    })
    const revision = await tx.reviewRevision.create({
      data: {
        requestId: request.id,
        revisionNumber,
        sourceFingerprint,
        fingerprint: reviewFingerprint,
        title: `Release ${input.repositoryOwner}/${input.repositoryName} PR #${input.pullRequestNumber}`,
        summary: "Authorize the exact reviewed commit and covered Task scope for production release dispatch.",
        packetJson: JSON.stringify({
          workspaceId: input.workspaceId,
          provider: input.provider,
          repositoryOwner: input.repositoryOwner,
          repositoryName: input.repositoryName,
          pullRequestNumber: input.pullRequestNumber,
          baseRef: input.baseRef,
          headSha: input.headSha,
          targetEnvironment: input.targetEnvironment,
          releasePolicyId: input.releasePolicyId,
          taskIds,
          sourceFingerprint,
        }),
        requiredRole: "ADMIN",
        options: {
          create: [
            { actionKey: "APPROVE_RELEASE", label: "Approve & release", outcomeClass: "APPROVE", continuationKey: RELEASE_CONTINUATION, sortOrder: 0 },
            { actionKey: "REJECT_RELEASE", label: "Reject release", outcomeClass: "REJECT", continuationKey: "NO_ACTION", sortOrder: 1 },
            { actionKey: "REQUEST_CHANGES", label: "Request changes", outcomeClass: "REQUEST_CHANGES", continuationKey: "NO_ACTION", sortOrder: 2 },
          ],
        },
      },
    })
    await tx.reviewRequest.update({
      where: { id: request.id },
      data: { currentRevisionId: revision.id, state: "PENDING", revisionCount: revisionNumber, updatedAt: new Date() },
    })
    const transitioned = await tx.releaseRun.updateMany({
      where: { id: releaseRun.id, version: releaseRun.version, state: "PREPARING" },
      data: { state: "READY_FOR_APPROVAL", version: releaseRun.version + 1, updatedAt: new Date() },
    })
    if (transitioned.count !== 1) throw new Error("ReleaseRun preparation compare-and-swap failed.")

    return {
      status: "READY",
      releaseRunId: releaseRun.id,
      requestId: request.id,
      revisionId: revision.id,
      sourceFingerprint,
      reviewFingerprint,
    }
  })
}

export async function recordReleaseDecision(input: Parameters<typeof recordDecision>[0]) {
  return recordDecision(input)
}

function dispatchIdempotencyKey(releaseRunId: string, decisionRecordId: string): string {
  return `release-dispatch:${releaseRunId}:${decisionRecordId}:v1`
}

function applicationReceiptKey(releaseRunId: string, decisionRecordId: string): string {
  return `release-authorization:${releaseRunId}:${decisionRecordId}:v1`
}

export async function queueAuthorizedRelease(
  releaseRunId: string,
  decisionRecordId: string,
  expectedSourceFingerprint: string,
): Promise<QueueReleaseResult> {
  const prisma = getPrisma()
  const idempotencyKey = dispatchIdempotencyKey(releaseRunId, decisionRecordId)

  try {
    return await prisma.$transaction(async (tx): Promise<QueueReleaseResult> => {
      const existingDispatch = await tx.releaseDispatch.findUnique({ where: { idempotencyKey } })
      if (existingDispatch) {
        return existingDispatch.releaseRunId === releaseRunId && existingDispatch.decisionRecordId === decisionRecordId
          ? { status: "EXISTING", dispatchId: existingDispatch.id }
          : { status: "BLOCKED", code: "DECISION_SCOPE_MISMATCH" }
      }

      const releaseRun = await tx.releaseRun.findUnique({
        where: { id: releaseRunId },
        include: { tasks: { select: { taskId: true } } },
      })
      if (!releaseRun) return { status: "BLOCKED", code: "DECISION_SCOPE_MISMATCH" }
      if (releaseRun.state === "SUPERSEDED" || releaseRun.state === "CANCELLED") {
        return { status: "BLOCKED", code: "REVOKED" }
      }
      if (releaseRun.state !== "READY_FOR_APPROVAL" && releaseRun.state !== "DECISION_RECORDING") {
        return { status: "BLOCKED", code: "STALE_SOURCE" }
      }

      const currentSourceFingerprint = releaseSourceFingerprint({
        workspaceId: releaseRun.workspaceId,
        provider: releaseRun.provider as ReleaseScope["provider"],
        repositoryOwner: releaseRun.repositoryOwner,
        repositoryName: releaseRun.repositoryName,
        pullRequestNumber: releaseRun.pullRequestNumber,
        baseRef: releaseRun.baseRef,
        headSha: releaseRun.headSha,
        targetEnvironment: releaseRun.targetEnvironment as ReleaseScope["targetEnvironment"],
        releasePolicyId: releaseRun.releasePolicyId,
        taskIds: releaseRun.tasks.map((task) => task.taskId),
      })
      if (releaseRun.sourceFingerprint !== expectedSourceFingerprint
        || currentSourceFingerprint !== expectedSourceFingerprint) {
        return { status: "BLOCKED", code: "STALE_SOURCE" }
      }

      const decision = await tx.decisionRecord.findUnique({
        where: { id: decisionRecordId },
        include: { revision: { include: { request: true } }, option: true },
      })
      if (!decision
        || decision.workspaceId !== releaseRun.workspaceId
        || decision.revision.request.workspaceId !== releaseRun.workspaceId
        || decision.revision.request.gateType !== "RELEASE_AUTHORIZATION"
        || decision.revision.request.subjectType !== "RELEASE_RUN"
        || decision.revision.request.subjectId !== releaseRun.id
        || decision.option.outcomeClass !== "APPROVE"
        || decision.option.continuationKey !== RELEASE_CONTINUATION
        || decision.fingerprint !== decision.revision.fingerprint
        || decision.revision.sourceFingerprint !== currentSourceFingerprint) {
        return { status: "BLOCKED", code: "DECISION_SCOPE_MISMATCH" }
      }
      if (decision.revision.supersededAt) return { status: "BLOCKED", code: "REVOKED" }
      if (releaseRun.authorizationDecisionRecordId
        && releaseRun.authorizationDecisionRecordId !== decisionRecordId) {
        return { status: "BLOCKED", code: "DECISION_SCOPE_MISMATCH" }
      }

      const receiptKey = applicationReceiptKey(releaseRunId, decisionRecordId)
      const existingApplication = await tx.decisionApplication.findUnique({ where: { receiptKey } })
      if (existingApplication) {
        const recoveredDispatch = await tx.releaseDispatch.findUnique({ where: { idempotencyKey } })
        return recoveredDispatch
          ? { status: "EXISTING", dispatchId: recoveredDispatch.id }
          : { status: "BLOCKED", code: "RETRYABLE_CONFLICT" }
      }

      const transitioned = await tx.releaseRun.updateMany({
        where: { id: releaseRun.id, version: releaseRun.version, authorizationDecisionRecordId: null },
        data: {
          authorizationDecisionRecordId: decisionRecordId,
          state: "DISPATCH_QUEUED",
          version: releaseRun.version + 1,
          lastErrorCode: null,
          lastError: null,
          updatedAt: new Date(),
        },
      })
      if (transitioned.count !== 1) return { status: "BLOCKED", code: "RETRYABLE_CONFLICT" }

      await tx.decisionApplication.create({
        data: {
          decisionId: decisionRecordId,
          continuationKey: RELEASE_CONTINUATION,
          targetType: "RELEASE_RUN",
          targetId: releaseRun.id,
          status: "APPLIED",
          receiptKey,
          attemptCount: 1,
          appliedAt: new Date(),
        },
      })
      const dispatch = await tx.releaseDispatch.create({
        data: {
          releaseRunId: releaseRun.id,
          decisionRecordId,
          continuationKey: RELEASE_CONTINUATION,
          status: "PENDING",
          idempotencyKey,
        },
      })
      return { status: "QUEUED", dispatchId: dispatch.id }
    })
  } catch (error) {
    const recovered = await prisma.releaseDispatch.findUnique({ where: { idempotencyKey } })
    if (recovered
      && recovered.releaseRunId === releaseRunId
      && recovered.decisionRecordId === decisionRecordId) {
      return { status: "EXISTING", dispatchId: recovered.id }
    }
    if ((error as { code?: string }).code === "P2002") return { status: "BLOCKED", code: "RETRYABLE_CONFLICT" }
    throw error
  }
}
