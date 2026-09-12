import getPrisma from "@/lib/db"
import { getDecisionArtifacts } from "@/lib/artifacts"
import { getMcpActor } from "@/lib/mcp-authz"
import { ok, fail } from "@/lib/mcp-output"
import { prepareReleaseRun, queueAuthorizedRelease, unconfiguredReleaseSourceRevalidator, type ReleaseScope } from "@/lib/release-authorization"
import { applyBuildingInvestmentDecision, applyBuildingInvestmentRevocationDecision, prepareBuildingInvestmentReview, prepareBuildingInvestmentRevocationReview, startNewBuildingInvestmentDecisionCycle } from "@/lib/building-investment"
import { createTrackedDecisionRequest, getTrackedDecision, listTrackedDecisions, type TrackedDecisionSourceInput, type TrackedSubjectType } from "@/lib/tracked-decisions"
import { reviewRequestUrl } from "@/lib/compass-url"

/**
 * Deep links to the human decision surface at /{orgSlug}/{workspaceSlug}/reviews/{requestId}.
 *
 * A human cannot call an MCP tool, so every gate that asks for a decision has to hand the
 * agent a URL it can relay. These helpers are deliberately non-throwing: `reviewRequestUrl`
 * throws when the deployment origin is unconfigured or untrusted, and several callers below
 * build the link inside a try/catch that would otherwise report a *successfully created*
 * review request as a failure. A missing link degrades to `null`; it never fails the gate.
 */
type WorkspaceSlugs = { orgSlug: string; workspaceSlug: string }

async function workspaceSlugs(workspaceId: string): Promise<WorkspaceSlugs | null> {
  try {
    const workspace = await getPrisma().workspace.findUnique({
      where: { id: workspaceId },
      select: { slug: true, organization: { select: { slug: true } } },
    })
    return workspace ? { orgSlug: workspace.organization.slug, workspaceSlug: workspace.slug } : null
  } catch {
    return null
  }
}

function buildReviewUrl(slugs: WorkspaceSlugs | null, requestId: string): string | null {
  if (!slugs) return null
  try {
    return reviewRequestUrl({ ...slugs, requestId })
  } catch {
    return null
  }
}

async function reviewUrlByWorkspace(workspaceId: string, requestId: string): Promise<string | null> {
  return buildReviewUrl(await workspaceSlugs(workspaceId), requestId)
}

async function reviewUrlByRequest(requestId: string): Promise<string | null> {
  try {
    const request = await getPrisma().reviewRequest.findUnique({
      where: { id: requestId },
      select: { workspaceId: true },
    })
    return request ? await reviewUrlByWorkspace(request.workspaceId, requestId) : null
  } catch {
    return null
  }
}

/** Appends a `URL:` line to a tool's human-readable message when a link is available. */
function withUrlLine(text: string, url: string | null): string {
  return url ? `${text}\nURL: ${url}` : text
}

export async function requestDecision(input: {
  workspaceId: string
  subjectType: TrackedSubjectType
  subjectId: string
  question: string
  context: string
  idempotencyKey: string
  sources?: TrackedDecisionSourceInput[]
}) {
  const actor = getMcpActor()
  try {
    const revision = await createTrackedDecisionRequest({ ...input, requestedById: actor.userId })
    const reviewUrl = await reviewUrlByWorkspace(input.workspaceId, revision.requestId)
    return ok(
      withUrlLine(`Decision requested.\nID: ${revision.requestId}\nRevision ID: ${revision.id}`, reviewUrl),
      { ...revision, reviewUrl },
    )
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not request decision.")
  }
}

export async function listDecisions(input: {
  workspaceId: string
  state?: "PENDING" | "DECIDED"
  subjectType?: TrackedSubjectType
  outcome?: "APPROVE" | "REQUEST_CHANGES" | "REJECT"
  reviewerId?: string
  query?: string
  page?: number
  pageSize?: number
}) {
  try {
    const result = await listTrackedDecisions({ ...input, tab: input.state })
    const slugs = await workspaceSlugs(input.workspaceId)
    const requests = result.requests.map((request) => ({ ...request, reviewUrl: buildReviewUrl(slugs, request.id) }))
    return ok(requests.length
      ? requests.map((request) => {
          const line = `• ${request.currentRevision?.title ?? request.subjectId} [${request.state}] (${request.id})`
          return request.reviewUrl ? `${line}\n  URL: ${request.reviewUrl}` : line
        }).join("\n")
      : "No decisions found.", { ...result, requests })
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not list decisions.")
  }
}

export async function getDecision({ workspaceId, requestId }: { workspaceId: string; requestId: string }) {
  try {
    const request = await getTrackedDecision(workspaceId, requestId)
    if (!request) return fail(`Decision "${requestId}" not found.`)
    const artifacts = await getDecisionArtifacts(workspaceId, requestId)
    const reviewUrl = await reviewUrlByWorkspace(workspaceId, request.id)
    return ok(
      withUrlLine(`${request.currentRevision?.title ?? "Decision"} [${request.state}]\nID: ${request.id}`, reviewUrl),
      { ...request, artifacts, reviewUrl },
    )
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not get decision.")
  }
}


export async function requestBuildingInvestment({ solutionId }: { solutionId: string }) {
  const actor = getMcpActor()
  try {
    const revision = await prepareBuildingInvestmentReview(solutionId, { requestedById: actor.userId })
    const reviewUrl = await reviewUrlByRequest(revision.requestId)
    return ok(
      withUrlLine(`Building investment review prepared.\nID: ${revision.requestId}\nRevision ID: ${revision.id}\nFingerprint: ${revision.fingerprint}`, reviewUrl),
      { ...revision, reviewUrl },
    )
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not prepare Building investment review.")
  }
}

export async function reconsiderBuildingInvestment({ solutionId, expectedTerminalDecisionId, reason }: { solutionId: string; expectedTerminalDecisionId: string; reason: string }) {
  const actor = getMcpActor()
  try {
    const revision = await startNewBuildingInvestmentDecisionCycle(solutionId, { expectedTerminalDecisionId, reason, actorUserId: actor.userId })
    const reviewUrl = await reviewUrlByRequest(revision.requestId)
    return ok(
      withUrlLine(`Building investment review reopened.\nID: ${revision.requestId}\nRevision ID: ${revision.id}`, reviewUrl),
      { ...revision, reviewUrl },
    )
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not reconsider Building investment.")
  }
}

export async function requestBuildingInvestmentRevocation({ solutionId, authorityDecisionId }: { solutionId: string; authorityDecisionId: string }) {
  const actor = getMcpActor()
  try {
    const revision = await prepareBuildingInvestmentRevocationReview(solutionId, authorityDecisionId, { requestedById: actor.userId })
    const reviewUrl = await reviewUrlByRequest(revision.requestId)
    return ok(
      withUrlLine(`Building investment revocation review prepared.\nID: ${revision.requestId}\nRevision ID: ${revision.id}`, reviewUrl),
      { ...revision, reviewUrl },
    )
  } catch (error) { return fail(error instanceof Error ? error.message : "Could not prepare Building investment revocation.") }
}


export async function requestReleaseAuthorization(scope: ReleaseScope) {
  const actor = getMcpActor()
  try {
    const result = await prepareReleaseRun({ ...scope, requestedById: actor.userId })
    if (result.status === "BLOCKED") return fail(`Release authorization blocked: ${result.code}`)
    const reviewUrl = await reviewUrlByWorkspace(scope.workspaceId, result.requestId)
    return ok(
      withUrlLine(
        `Release authorization review prepared.\nID: ${result.requestId}\nRelease run: ${result.releaseRunId}\nRevision ID: ${result.revisionId}`,
        reviewUrl,
      ),
      { ...result, reviewUrl },
    )
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not prepare release authorization review.")
  }
}

export async function getReviewRequest({ requestId }: { requestId: string }) {
  const request = await getPrisma().reviewRequest.findUnique({
    where: { id: requestId },
    include: { currentRevision: { include: { options: { orderBy: { sortOrder: "asc" } }, decisions: true } } },
  })
  if (!request) return fail(`Review request "${requestId}" not found.`)
  const artifacts = request.gateType === "TRACKED_DECISION" ? await getDecisionArtifacts(request.workspaceId, requestId) : []
  const reviewUrl = await reviewUrlByWorkspace(request.workspaceId, request.id)
  return ok(
    withUrlLine(`Review request ${request.id} [${request.state}]\nGate: ${request.gateType}\nSubject: ${request.subjectType} ${request.subjectId}`, reviewUrl),
    { ...request, artifacts, reviewUrl },
  )
}

export async function listReviewRequests({ workspaceId, state }: { workspaceId: string; state?: string }) {
  const rows = await getPrisma().reviewRequest.findMany({
    where: { workspaceId, ...(state ? { state } : {}) },
    include: { currentRevision: { select: { title: true, fingerprint: true } } },
    orderBy: { updatedAt: "desc" },
  })
  const slugs = await workspaceSlugs(workspaceId)
  const requests = rows.map((request) => ({ ...request, reviewUrl: buildReviewUrl(slugs, request.id) }))
  return ok(requests.length
    ? requests.map((request) => {
        const line = `• ${request.currentRevision?.title ?? request.subjectId} [${request.state}] (${request.id})`
        return request.reviewUrl ? `${line}\n  URL: ${request.reviewUrl}` : line
      }).join("\n")
    : "No review requests found.", { requests })
}

export async function applyRecordedDecision({ decisionId }: { decisionId: string }) {
  const prisma = getPrisma()
  const decision = await prisma.decisionRecord.findUnique({ where: { id: decisionId }, include: { revision: { include: { request: true } } } })
  if (!decision) return fail(`Decision "${decisionId}" not found.`)
  try {
    if (decision.revision.request.gateType === "BUILDING_INVESTMENT") {
      const receipt = await applyBuildingInvestmentDecision(decision.revision.request.subjectId, decision.id)
      return ok(`Decision applied.\nID: ${receipt.id}\nReceipt: ${receipt.receiptKey}\nStatus: ${receipt.status}`, receipt)
    }
    if (decision.revision.request.gateType === "BUILDING_INVESTMENT_REVOCATION") {
      const receipt = await applyBuildingInvestmentRevocationDecision(decision.revision.request.subjectId, decision.id)
      return ok(`Decision applied.\nID: ${receipt.id}\nReceipt: ${receipt.receiptKey}\nStatus: ${receipt.status}`, receipt)
    }
    if (decision.revision.request.gateType === "RELEASE_AUTHORIZATION" && decision.revision.sourceFingerprint) {
      const dispatch = await queueAuthorizedRelease(
        decision.revision.request.subjectId,
        decision.id,
        decision.revision.sourceFingerprint,
        unconfiguredReleaseSourceRevalidator,
      )
      if (dispatch.status === "BLOCKED") return fail(`Release dispatch blocked: ${dispatch.code}`)
      return ok(`Release dispatch recorded.\nID: ${dispatch.dispatchId}\nStatus: ${dispatch.status}`, dispatch)
    }
    return fail(`Decision gate "${decision.revision.request.gateType}" does not have an applicator.`)
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not apply decision.")
  }
}
