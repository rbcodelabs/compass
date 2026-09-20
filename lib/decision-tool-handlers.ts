import getPrisma from "@/lib/db"
import { getDecisionArtifacts } from "@/lib/artifacts"
import { getMcpActor } from "@/lib/mcp-authz"
import { ok, fail } from "@/lib/mcp-output"
import { prepareReleaseRun, queueAuthorizedRelease, unconfiguredReleaseSourceRevalidator, type ReleaseScope } from "@/lib/release-authorization"
import { applyTrackedDecision, createTrackedDecisionRequest, getTrackedDecision, listTrackedDecisions, recordDecisionNoAction, TrackedDecisionError, type TrackedDecisionSourceInput, type TrackedSubjectType } from "@/lib/tracked-decisions"
import { CompassUrlNotConfiguredError, reviewRequestUrl, withUrlLine } from "@/lib/compass-url"

/**
 * Deep links to the human decision surface at /{orgSlug}/{workspaceSlug}/reviews/{requestId}.
 *
 * A human cannot call an MCP tool, so every gate that asks for a decision has to hand the
 * agent a URL it can relay. A link the deployment simply can't build — no configured origin —
 * degrades to `null` rather than reporting a *successfully created* review request as a
 * failure. An unsafe *configured* origin is a different matter and propagates: see the
 * CompassUrlNotConfiguredError doc in lib/compass-url.ts, and `canonicalFeedbackUrl` in
 * lib/feedback-tool-handlers.ts, which has always drawn that line.
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
  } catch (error) {
    // Only a *missing* origin degrades to a null link. A configured-but-unsafe
    // origin (non-HTTPS, embedded credentials, malformed) must abort — the bare
    // `catch {}` this replaced swallowed it, silently dropping review links on a
    // misconfigured deployment instead of surfacing the misconfiguration.
    if (error instanceof CompassUrlNotConfiguredError) return null
    throw error
  }
}

async function reviewUrlByWorkspace(workspaceId: string, requestId: string): Promise<string | null> {
  return buildReviewUrl(await workspaceSlugs(workspaceId), requestId)
}

export type ResolvedRequester = { type: "USER" | "AGENT"; id: string; name: string } | null

/**
 * Resolves who actually raised a decision, preferring the Agent identity
 * (requestedByAgentId) over the API-key-owning user (requestedById) when
 * both are present -- an agent-raised request always has requestedById set
 * too (it's the agent's owner), but the agent is the one that was blocked
 * waiting on the answer, so it's the more useful "who asked" identity for a
 * suggested-assignee default. See feedback f546cf13-e6a0-4213-8be9-0cfdebbf4ff7
 * and the requested_by_agent_id column comment in prisma/schema.prisma.
 */
async function resolveRequester(request: { requestedById: string | null; requestedByAgentId: string | null }): Promise<ResolvedRequester> {
  const prisma = getPrisma()
  if (request.requestedByAgentId) {
    const agent = await prisma.agent.findUnique({ where: { id: request.requestedByAgentId }, select: { id: true, name: true } })
    if (agent) return { type: "AGENT", id: agent.id, name: agent.name }
  }
  if (request.requestedById) {
    const user = await prisma.user.findUnique({ where: { id: request.requestedById }, select: { id: true, name: true, email: true } })
    if (user) return { type: "USER", id: user.id, name: user.name ?? user.email }
  }
  return null
}

/** Follow-up work linked to a decision via the DECISION TaskLink type (item 3: reciprocal display). */
async function resolveFollowUpTasks(requestId: string) {
  const prisma = getPrisma()
  const links = await prisma.taskLink.findMany({ where: { linkedType: "DECISION", linkedId: requestId }, select: { task: { select: { id: true, title: true, status: true } } } })
  return links.map((link) => link.task)
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
    // requestedById is always the API key's owning user, even when the
    // caller is an agent (an agent's owner) -- see the schema comment on
    // requestedByAgentId. Only persist an agent id when the actor is
    // genuinely acting as an agent, so a suggested assignee later points at
    // the agent that was blocked waiting on this decision, not its owner.
    const requestedByAgentId = actor.purpose === "AGENT" ? (actor.agentId ?? null) : null
    const revision = await createTrackedDecisionRequest({ ...input, requestedById: actor.userId, requestedByAgentId })
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
    const requests = await Promise.all(result.requests.map(async (request) => ({
      ...request,
      reviewUrl: buildReviewUrl(slugs, request.id),
      requestedBy: await resolveRequester(request),
    })))
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
    const [artifacts, requestedBy, followUpTasks] = await Promise.all([
      getDecisionArtifacts(workspaceId, requestId),
      resolveRequester(request),
      resolveFollowUpTasks(requestId),
    ])
    const reviewUrl = await reviewUrlByWorkspace(workspaceId, request.id)
    const noAction = request.noActionAt ? { at: request.noActionAt, reason: request.noActionReason } : null
    const lines = [
      `${request.currentRevision?.title ?? "Decision"} [${request.state}]`,
      requestedBy ? `Requested by: ${requestedBy.name} (${requestedBy.type.toLowerCase()})` : null,
      followUpTasks.length ? `Follow-up work (${followUpTasks.length}):\n` + followUpTasks.map((task) => `  • [${task.status}] ${task.title} — ID: ${task.id}`).join("\n") : null,
      noAction ? `No action needed: ${noAction.reason}` : null,
      `ID: ${request.id}`,
    ].filter((line): line is string => line !== null)
    return ok(
      withUrlLine(lines.join("\n"), reviewUrl),
      { ...request, artifacts, reviewUrl, requestedBy, followUpTasks, noAction },
    )
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not get decision.")
  }
}

export async function closeDecisionNoAction({ workspaceId, requestId, reason }: { workspaceId: string; requestId: string; reason: string }) {
  const actor = getMcpActor()
  try {
    const request = await recordDecisionNoAction({ workspaceId, requestId, reason, actorUserId: actor.userId })
    const reviewUrl = await reviewUrlByWorkspace(workspaceId, request.id)
    return ok(
      withUrlLine(`**Closed, no action needed.**\nReason: ${reason}\nID: ${request.id}`, reviewUrl),
      { ...request, reviewUrl },
    )
  } catch (error) {
    if (error instanceof TrackedDecisionError) return fail(error.message)
    return fail(error instanceof Error ? error.message : "Could not close decision.")
  }
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
    if (decision.revision.request.gateType === "TRACKED_DECISION") {
      const receipt = await applyTrackedDecision(decision.id)
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
