import getPrisma from "@/lib/db"
import { agentWorkspaceWhere } from "@/lib/agent-access"
import { assertOrgAdminBySlug, assertScoringModelAccess, assertWorkspaceAdmin, assertWorkspaceMember, getMcpActor, isServiceActor } from "@/lib/mcp-authz"
import { decodeCursor, decodeOrderedCursor, encodeCursor, encodeOrderedCursor, type OrderedCursorPayload } from "@/lib/rest/cursor"
import type { RestAuthorizationPolicy, RestRoute } from "@/lib/rest/registry"
import { createOpportunity, updateOpportunity, updateOpportunityKeyResult, updateOpportunityStatus } from "@/lib/opportunity-tool-handlers"
import { createSolution, updateSolution } from "@/lib/solution-tool-handlers"
import { updateSolutionStatus } from "@/lib/solution-status-tool-handlers"
import { createAssumption, deleteAssumption, updateAssumption } from "@/lib/assumption-tool-handlers"
import { createFeedback, linkFeedbackToOpportunity, prepareFeedbackAttachmentUploadTool, updateFeedback, updateFeedbackStatus, updateFeedbackType } from "@/lib/feedback-tool-handlers"
import { createTask, moveTaskStatus, updateTask } from "@/lib/task-tool-handlers"
import { linkTask, unlinkTask } from "@/lib/task-tool-handlers"
import { createRoadmapItem, getLaunchChecklist, setLaunchTier, updateLaunchChecklistItem, updateRoadmapItem } from "@/lib/roadmap-tool-handlers"
import {
  linkOpportunityToObjectiveTool,
  linkSolutionToKeyResultTool,
  unlinkOpportunityFromObjectiveTool,
  unlinkSolutionFromKeyResultTool,
} from "@/lib/typed-link-tool-handlers"
import type { ToolResult } from "@/lib/mcp-output"
import { deleteKeyResult, deleteObjective, updateKeyResult, updateObjective } from "@/lib/okr-tool-handlers"
import { updateExperiment } from "@/lib/experiment-update-tool"
import { handleAnalyticsTool } from "@/lib/analytics/tool-handlers"
import * as analyticsService from "@/lib/analytics/service"
import { getCustomFieldValues, setCustomFieldValue } from "@/lib/custom-field-tool-handlers"
import { toCustomFieldDefinitionData } from "@/lib/custom-field-definitions"
import type { CustomFieldValue } from "@/lib/types"
import { listLinksTool } from "@/lib/typed-link-tool-handlers"
import { getEligibleParentKeyResults } from "@/lib/okr-hierarchy"
import { archiveScoringModel, createScoringModel, getOpportunityScore, getSolutionScore, listScoringModels, scoreOpportunity, scoreSolution, updateScoringModel } from "@/lib/scoring-tool-handlers"
import { captureWorkspaceMutation } from "@/lib/workspace-update-mutations"
import { createComment, getComment, resolveCommentTarget, setCommentStatus, updateCommentBody } from "@/lib/comments"
import { followTool, markReadTool, unfollowTool } from "@/lib/follow-tool-handlers"
import { listNotifications, unreadCount } from "@/lib/notifications"
import { createDoc, getDoc, updateDoc } from "@/lib/doc-tool-handlers"
import { createDocVersion, getDocVersion, restoreDocVersion } from "@/lib/doc-version-tool-handlers"
import { deleteDocComment, getDocComment, reopenDocComment, resolveDocComment, updateDocComment } from "@/lib/doc-comment-tool-handlers"
import { createDocCommentCore } from "@/lib/doc-comments"
import { prepareDocImageUploadTool } from "@/lib/doc-image-tool-handlers"
import { documentRevision } from "@/lib/document-service"
import { archiveArtifact, createArtifact, getArtifact, linkArtifact, linkArtifactDecision, unlinkArtifact, unlinkArtifactDecision, updateArtifact } from "@/lib/artifact-tool-handlers"
import { getDecision, getReviewRequest, listDecisions, requestDecision, requestReleaseAuthorization } from "@/lib/decision-tool-handlers"
import { addSolutionComment, addSolutionPlan, deleteSolutionComment, getSolutionComment, updateSolutionComment } from "@/lib/solution-comment-tool-handlers"
import * as researchStudies from "@/lib/research-study-service"
import { ResearchAnalysisError, storeAgentStudySynthesis } from "@/lib/research-analysis-service"
import { promoteResearchFindingToEvidence, ResearchPromotionError } from "@/lib/research-evidence-promotion"
import { researchParticipantUrl } from "@/lib/compass-url"
import { PmInterviewError, readOwnedPmInterview } from "@/lib/pm-interview-service"
import { createCardSortRound, getCardSortTally, listCardSortFactors, listCardSortRounds, listMyCardSortProposals, loadCardSortBoard, proposeCardSortMoves, setCardSortRoundState, withdrawCardSortProposal, CardSortError, CARD_SORT_ERROR_STATUS } from "@/lib/card-sort"
import { acceptCardSortNewEntry, listCardSortNewEntries, proposeCardSortNewEntry, rejectCardSortNewEntry, withdrawCardSortNewEntry } from "@/lib/card-sort-new-entries"

export class RestNotFoundError extends Error {}
export class RestForbiddenError extends Error {}
export class RestBadRequestError extends Error {}
export class RestConflictError extends Error {}
export class RestCursorError extends Error {}
export class RestValidationError extends Error {}

type Input = { params: Record<string, string>; query: Record<string, unknown>; body: Record<string, unknown> | undefined }

const select = {
  workspace: { id: true, organizationId: true, slug: true, name: true, description: true, createdAt: true, updatedAt: true },
  opportunity: { id: true, workspaceId: true, title: true, description: true, customerSegment: true, status: true, squadId: true, linkedKeyResultId: true, createdAt: true, updatedAt: true },
  solution: { id: true, workspaceId: true, opportunityId: true, title: true, description: true, status: true, createdAt: true, updatedAt: true },
  assumption: { id: true, solutionId: true, title: true, description: true, riskLevel: true, status: true, createdAt: true, updatedAt: true },
  feedback: { id: true, workspaceId: true, opportunityId: true, title: true, description: true, type: true, status: true, voteCount: true, tags: true, submitterName: true, submitterEmail: true, createdAt: true, updatedAt: true },
  task: { id: true, workspaceId: true, squadId: true, parentTaskId: true, title: true, description: true, status: true, priority: true, assigneeUserId: true, assigneeAgentId: true, ownerName: true, storyPoints: true, dueDate: true, iteration: true, createdAt: true, updatedAt: true },
  roadmap: { id: true, workspaceId: true, squadId: true, title: true, description: true, horizon: true, status: true, isPrivate: true, startDate: true, endDate: true, solutionId: true, keyResultId: true, opportunityId: true, experimentId: true, feedbackId: true, createdAt: true, updatedAt: true },
  cycle: { id: true, workspaceId: true, title: true, startDate: true, endDate: true, status: true, createdAt: true, updatedAt: true },
  objective: { id: true, workspaceId: true, cycleId: true, squadId: true, parentKeyResultId: true, title: true, description: true, owner: true, status: true, sortOrder: true, createdAt: true, updatedAt: true },
  keyResult: { id: true, objectiveId: true, title: true, target: true, current: true, unit: true, sortOrder: true, createdAt: true, updatedAt: true },
  checkIn: { id: true, keyResultId: true, value: true, note: true, createdAt: true },
  experiment: { id: true, workspaceId: true, squadId: true, assumptionId: true, title: true, hypothesis: true, method: true, killCondition: true, status: true, startDate: true, endDate: true, conclusion: true, conclusionReason: true, createdAt: true, updatedAt: true },
  experimentResult: { id: true, experimentId: true, note: true, metric: true, value: true, createdAt: true },
  squad: { id: true, workspaceId: true, name: true, color: true, createdAt: true },
  scoringModel: { id: true, organizationId: true, name: true, description: true, status: true, formulaType: true, version: true, createdAt: true, updatedAt: true, metrics: { select: { key: true, label: true, description: true, minValue: true, maxValue: true, weight: true, direction: true, order: true }, orderBy: { order: "asc" as const } } },
  opportunityScore: { id: true, opportunityId: true, scoringModelId: true, modelVersion: true, formulaSnapshot: true, rawValues: true, rawScore: true, normalizedScore: true, scoredAt: true, createdAt: true, updatedAt: true },
  solutionScore: { id: true, solutionId: true, scoringModelId: true, modelVersion: true, formulaSnapshot: true, rawValues: true, rawScore: true, normalizedScore: true, scoredAt: true, createdAt: true, updatedAt: true },
} as const

export async function executeRestRoute(route: RestRoute, input: Input): Promise<unknown> {
  const prisma = getPrisma()
  const actor = getMcpActor()
  const mutationActor = actor.purpose === "AGENT" || actor.purpose === "AGENT_TURN"
    ? { actorType: "AGENT" as const, actorId: actor.agentId ?? null }
    : actor.userId ? { actorType: "USER" as const, actorId: actor.userId } : { actorType: "SYSTEM" as const, actorId: null }
  const workspaceId = input.params.workspaceId
  await enforcePolicy(route.authorizationPolicy, actor, workspaceId)
  const body = input.body ?? {}
  const id = input.params.id

  switch (route.operationId) {
    case "getCurrentIdentity": {
      const workspaces = await prisma.workspace.findMany({ where: await agentWorkspaceWhere(actor), select: { id: true, name: true, slug: true }, orderBy: [{ name: "asc" }, { id: "asc" }] })
      return { purpose: actor.purpose ?? "USER", userId: actor.userId, agentId: actor.agentId ?? null, workspaces }
    }
    case "listWorkspaces": {
      const where = isServiceActor(actor) ? {} : await agentWorkspaceWhere(actor)
      return listPage("workspaces", input.query, (cursor, take) => prisma.workspace.findMany({ where: { AND: [where, cursorWhere(cursor)] }, select: select.workspace, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take }))
    }
    case "getWorkspace": return serialize(found(await prisma.workspace.findFirst({ where: { id: workspaceId, ...(isServiceActor(actor) ? {} : await agentWorkspaceWhere(actor)) }, select: select.workspace })))

    case "listOpportunities": return listPage(`opportunities:${workspaceId}:${filters(input.query, ["status", "squadId"])}`, input.query, (cursor, take) => prisma.opportunity.findMany({ where: { workspaceId, ...pick(input.query, ["status", "squadId"]), ...cursorWhere(cursor) }, select: select.opportunity, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take }))
    case "getOpportunity": return serialize(found(await prisma.opportunity.findFirst({ where: { id, workspaceId }, select: select.opportunity })))
    case "createOpportunity": { await validateOpportunityRefs(prisma, workspaceId, body); const result = ensureTool(await createOpportunity({ workspaceId, title: String(body.title), description: nullable(body.description), customerSegment: nullable(body.customerSegment), status: body.status as "EXPLORING" | "VALIDATING" | "PRIORITIZED" | "ACTIVE" | undefined, squadId: nullable(body.squadId), keyResultId: nullable(body.linkedKeyResultId), source: "API" })); return serialize(found(await prisma.opportunity.findFirst({ where: { workspaceId, id: String((result as { id: string }).id) }, select: select.opportunity }))) }
    case "updateOpportunity": {
      await validateOpportunityRefs(prisma, workspaceId, body)
      const existing = await prisma.opportunity.findFirst({ where: { id, workspaceId }, select: { id: true } }); if (!existing) throw new RestNotFoundError()
      const editable = pick(body, ["title", "description", "customerSegment"])
      if (Object.keys(editable).length) ensureTool(await updateOpportunity({ opportunityId: id, ...editable }))
      if (body.status) ensureTool(await updateOpportunityStatus({ opportunityId: id, status: body.status as "EXPLORING" | "VALIDATING" | "PRIORITIZED" | "ACTIVE" | "ARCHIVED", source: "API" }))
      if (body.linkedKeyResultId !== undefined) ensureTool(await updateOpportunityKeyResult({ opportunityId: id, keyResultId: nullable(body.linkedKeyResultId) ?? null, workspaceId, source: "API" }))
      return serialize(found(await prisma.opportunity.findFirst({ where: { id, workspaceId }, select: select.opportunity })))
    }
    case "linkOpportunityObjective": {
      const data = ensureTool(await linkOpportunityToObjectiveTool({ workspaceId, opportunityId: id, objectiveId: String(body.objectiveId), source: "API" })) as { link: unknown }
      return serialize(data.link)
    }
    case "unlinkOpportunityObjective": {
      ensureTool(await unlinkOpportunityFromObjectiveTool({ workspaceId, opportunityId: id, objectiveId: input.params.relatedId }))
      return undefined
    }

    case "listSolutions": return listPage(`solutions:${workspaceId}:${filters(input.query, ["status", "opportunityId"])}`, input.query, (cursor, take) => prisma.solution.findMany({ where: { workspaceId, ...pick(input.query, ["status", "opportunityId"]), ...cursorWhere(cursor) }, select: select.solution, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take }))
    case "getSolution": return serialize(found(await prisma.solution.findFirst({ where: { id, workspaceId }, select: select.solution })))
    case "createSolution": {
      const opportunity = await prisma.opportunity.findFirst({ where: { id: String(body.opportunityId), workspaceId }, select: { id: true } })
      if (!opportunity) throw new RestNotFoundError()
      const result = ensureTool(await createSolution({ opportunityId: opportunity.id, title: String(body.title), description: nullable(body.description), source: "API" })); return serialize(found(await prisma.solution.findFirst({ where: { id: String((result as { id: string }).id), workspaceId }, select: select.solution })))
    }
    case "updateSolution": { const existing = await prisma.solution.findFirst({ where: { id, workspaceId }, select: { id: true } }); if (!existing) throw new RestNotFoundError(); const editable = pick(body, ["title", "description"]); if (editable.description === null) editable.description = ""; if (Object.keys(editable).length) ensureTool(await updateSolution({ solutionId: id, ...editable })); if (body.status) ensureTool(await updateSolutionStatus({ solutionId: id, status: body.status as never, source: "API" })); return serialize(found(await prisma.solution.findFirst({ where: { id, workspaceId }, select: select.solution }))) }
    case "linkSolutionKeyResult": {
      const data = ensureTool(await linkSolutionToKeyResultTool({ workspaceId, solutionId: id, keyResultId: String(body.keyResultId), source: "API" })) as { link: unknown }
      return serialize(data.link)
    }
    case "unlinkSolutionKeyResult": {
      ensureTool(await unlinkSolutionFromKeyResultTool({ workspaceId, solutionId: id, keyResultId: input.params.relatedId }))
      return undefined
    }

    case "listAssumptions": return listPage(`assumptions:${workspaceId}:${filters(input.query, ["status", "riskLevel", "solutionId"])}`, input.query, (cursor, take) => prisma.assumption.findMany({ where: { solution: { workspaceId }, ...pick(input.query, ["status", "riskLevel", "solutionId"]), ...cursorWhere(cursor) }, select: select.assumption, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take }))
    case "getAssumption": return serialize(found(await prisma.assumption.findFirst({ where: { id, solution: { workspaceId } }, select: select.assumption })))
    case "createAssumption": {
      const solution = await prisma.solution.findFirst({ where: { id: String(body.solutionId), workspaceId }, select: { id: true } })
      if (!solution) throw new RestNotFoundError()
      const result = ensureTool(await createAssumption({ solutionId: solution.id, title: String(body.title), description: nullable(body.description), riskLevel: body.riskLevel as "HIGH" | "MEDIUM" | "LOW" | undefined, source: "API" })); return serialize(found(await prisma.assumption.findFirst({ where: { id: String((result as { id: string }).id), solution: { workspaceId } }, select: select.assumption })))
    }
    case "updateAssumption": { const existing = await prisma.assumption.findFirst({ where: { id, solution: { workspaceId } }, select: { id: true } }); if (!existing) throw new RestNotFoundError(); ensureTool(await updateAssumption({ assumptionId: id, ...body, source: "API" })); return serialize(found(await prisma.assumption.findFirst({ where: { id, solution: { workspaceId } }, select: select.assumption }))) }
    case "deleteAssumption": {
      const existing = await prisma.assumption.findFirst({ where: { id, solution: { workspaceId } }, select: { id: true } })
      if (!existing) throw new RestNotFoundError()
      ensureTool(await deleteAssumption({ assumptionId: id }))
      return undefined
    }

    case "listFeedback": return listPage(`feedback:${workspaceId}:${filters(input.query, ["status", "type", "opportunityId"])}`, input.query, (cursor, take) => prisma.feedbackItem.findMany({ where: { workspaceId, ...pick(input.query, ["status", "type", "opportunityId"]), ...cursorWhere(cursor) }, select: select.feedback, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take }))
    case "getFeedback": return serialize(found(await prisma.feedbackItem.findFirst({ where: { id, workspaceId }, select: select.feedback })))
    case "createFeedback": { const result = ensureTool(await createFeedback({ workspaceId, title: String(body.title), description: nullable(body.description) ?? undefined, type: body.type as "BUG" | "IDEA" | undefined, submitterName: nullable(body.submitterName) ?? undefined, submitterEmail: nullable(body.submitterEmail) ?? undefined, source: "API" })); const createdId = String((result as { id: string }).id); return serialize(found(await prisma.feedbackItem.findFirst({ where: { id: createdId, workspaceId }, select: select.feedback }))) }
    case "updateFeedback": { await validateFeedbackRefs(prisma, workspaceId, body); const existing = await prisma.feedbackItem.findFirst({ where: { id, workspaceId }, select: { id: true } }); if (!existing) throw new RestNotFoundError(); const text = pick(body, ["title", "description"]); if (Object.keys(text).length) ensureTool(await updateFeedback({ feedbackId: id, ...text })); if (body.status) ensureTool(await updateFeedbackStatus({ feedbackId: id, status: body.status as never })); if (body.type) ensureTool(await updateFeedbackType({ feedbackId: id, type: body.type as "BUG" | "IDEA" })); if (typeof body.opportunityId === "string") ensureTool(await linkFeedbackToOpportunity({ feedbackId: id, opportunityId: body.opportunityId })); return serialize(found(await prisma.feedbackItem.findFirst({ where: { id, workspaceId }, select: select.feedback }))) }
    case "prepareFeedbackAttachmentUpload": return serialize(ensureTool(await prepareFeedbackAttachmentUploadTool({ workspaceId, filename: String(body.filename), fileType: String(body.fileType), fileSize: Number(body.fileSize) })))

    case "listTasks": return listPage(`tasks:${workspaceId}:${filters(input.query, ["status", "priority", "squadId", "parentTaskId"])}`, input.query, (cursor, take) => prisma.task.findMany({ where: { workspaceId, ...pick(input.query, ["status", "priority", "squadId", "parentTaskId"]), ...cursorWhere(cursor) }, select: select.task, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take }))
    case "getTask": return serialize(found(await prisma.task.findFirst({ where: { id, workspaceId }, select: select.task })))
    case "createTask": { await validateTaskRefs(prisma, workspaceId, body); const input = body as unknown as Omit<Parameters<typeof createTask>[0], "workspaceId">; const result = ensureTool(await createTask({ workspaceId, ...input, source: "API" })); return serialize(found(await prisma.task.findFirst({ where: { id: String((result as { id: string }).id), workspaceId }, select: select.task }))) }
    case "updateTask": { await validateTaskRefs(prisma, workspaceId, body); const existing = await prisma.task.findFirst({ where: { id, workspaceId }, select: { id: true } }); if (!existing) throw new RestNotFoundError(); const editable = { ...body }; delete editable.status; if (Object.keys(editable).length) ensureTool(await updateTask({ taskId: id, ...(editable as Omit<Parameters<typeof updateTask>[0], "taskId">), source: "API" })); if (body.status) ensureTool(await moveTaskStatus({ taskId: id, status: body.status as never, source: "API" })); return serialize(found(await prisma.task.findFirst({ where: { id, workspaceId }, select: select.task }))) }
    case "linkTaskResource": {
      if (!(await prisma.task.findFirst({ where: { id, workspaceId }, select: { id: true } }))) throw new RestNotFoundError()
      return serialize(ensureTool(await linkTask({ taskId: id, linkedType: body.linkedType as Parameters<typeof linkTask>[0]["linkedType"], linkedId: String(body.linkedId) })))
    }
    case "unlinkTaskResource": {
      if (!(await prisma.task.findFirst({ where: { id, workspaceId }, select: { id: true } }))) throw new RestNotFoundError()
      ensureTool(await unlinkTask({ taskId: id, linkedType: input.params.linkedType as Parameters<typeof unlinkTask>[0]["linkedType"], linkedId: input.params.relatedId }))
      return undefined
    }

    case "listRoadmapItems": return listPage(`roadmap:${workspaceId}:${filters(input.query, ["horizon", "status", "squadId"])}`, input.query, (cursor, take) => prisma.roadmapItem.findMany({ where: { workspaceId, ...pick(input.query, ["horizon", "status", "squadId"]), ...cursorWhere(cursor) }, select: select.roadmap, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take }))
    case "createRoadmapItem": {
      await validateRoadmapRefs(prisma, workspaceId, body)
      const result = ensureTool(await createRoadmapItem({ workspaceId, ...(body as Omit<Parameters<typeof createRoadmapItem>[0], "workspaceId">), source: "API" })) as { id: string }
      return serialize(found(await prisma.roadmapItem.findFirst({ where: { id: result.id, workspaceId }, select: select.roadmap })))
    }
    case "getRoadmapItem": return serialize(found(await prisma.roadmapItem.findFirst({ where: { id, workspaceId }, select: select.roadmap })))
    case "updateRoadmapItem": {
      if (body.horizon === "LAUNCHING" || body.horizon === "LAUNCHED") throw new RestConflictError("Use the launch workflow resource for this transition.")
      await validateRoadmapRefs(prisma, workspaceId, body)
      const existing = await prisma.roadmapItem.findFirst({ where: { id, workspaceId }, select: { id: true } }); if (!existing) throw new RestNotFoundError()
      ensureTool(await updateRoadmapItem({ itemId: id, ...(body as Omit<Parameters<typeof updateRoadmapItem>[0], "itemId">), source: "API" }))
      return serialize(found(await prisma.roadmapItem.findFirst({ where: { id, workspaceId }, select: select.roadmap })))
    }

    case "listOkrCycles": return listPage(`okr-cycles:${workspaceId}`, input.query, (cursor, take) => prisma.oKRCycle.findMany({ where: { workspaceId, ...cursorWhere(cursor) }, select: select.cycle, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take }))
    case "getOkrCycle": return serialize(found(await prisma.oKRCycle.findFirst({ where: { id, workspaceId }, select: select.cycle })))
    case "createOkrCycle": return serialize(await prisma.oKRCycle.create({ data: { workspaceId, title: String(body.title), startDate: new Date(String(body.startDate)), endDate: new Date(String(body.endDate)), status: String(body.status ?? "ACTIVE") }, select: select.cycle }))
    case "listObjectives": return listPage(`objectives:${workspaceId}:${filters(input.query, ["cycleId", "status"])}`, input.query, (cursor, take) => prisma.objective.findMany({ where: { workspaceId, ...pick(input.query, ["cycleId", "status"]), ...cursorWhere(cursor) }, select: select.objective, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take }))
    case "getObjective": return serialize(found(await prisma.objective.findFirst({ where: { id, workspaceId }, select: select.objective })))
    case "createObjective": {
      await validateObjectiveRefs(prisma, workspaceId, body)
      const scope = found(await prisma.workspace.findFirst({ where: { id: workspaceId }, select: { id: true } }))
      return serialize(await prisma.objective.create({ data: { workspaceId: scope.id, cycleId: nullable(body.cycleId) ?? null, squadId: nullable(body.squadId) ?? null, parentKeyResultId: nullable(body.parentKeyResultId) ?? null, title: String(body.title), description: nullable(body.description), owner: nullable(body.owner), source: "API" }, select: select.objective }))
    }
    case "updateObjective": { if (!(await prisma.objective.findFirst({ where: { id, workspaceId }, select: { id: true } }))) throw new RestNotFoundError(); ensureTool(await updateObjective({ objectiveId: id, ...body })); return serialize(found(await prisma.objective.findFirst({ where: { id, workspaceId }, select: select.objective }))) }
    case "deleteObjective": { if (!(await prisma.objective.findFirst({ where: { id, workspaceId }, select: { id: true } }))) throw new RestNotFoundError(); ensureTool(await deleteObjective({ objectiveId: id })); return undefined }
    case "listKeyResults": { await requireObjective(prisma, workspaceId, id); return listPage(`key-results:${workspaceId}:${id}`, input.query, (cursor, take) => prisma.keyResult.findMany({ where: { objectiveId: id, objective: { workspaceId }, ...cursorWhere(cursor) }, select: select.keyResult, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take })) }
    case "getKeyResult": return serialize(found(await prisma.keyResult.findFirst({ where: { id, objective: { workspaceId } }, select: select.keyResult })))
    case "createKeyResult": { await requireObjective(prisma, workspaceId, id); return serialize(await prisma.keyResult.create({ data: { objectiveId: id, title: String(body.title), target: Number(body.target), unit: nullable(body.unit), source: "API" }, select: select.keyResult })) }
    case "updateKeyResult": { if (!(await prisma.keyResult.findFirst({ where: { id, objective: { workspaceId } }, select: { id: true } }))) throw new RestNotFoundError(); ensureTool(await updateKeyResult({ keyResultId: id, ...body })); return serialize(found(await prisma.keyResult.findFirst({ where: { id, objective: { workspaceId } }, select: select.keyResult }))) }
    case "deleteKeyResult": { if (!(await prisma.keyResult.findFirst({ where: { id, objective: { workspaceId } }, select: { id: true } }))) throw new RestNotFoundError(); ensureTool(await deleteKeyResult({ keyResultId: id })); return undefined }
    case "listCheckIns": { await requireKeyResult(prisma, workspaceId, id); return listPage(`check-ins:${workspaceId}:${id}`, input.query, (cursor, take) => prisma.checkIn.findMany({ where: { keyResultId: id, keyResult: { objective: { workspaceId } }, ...cursorWhere(cursor) }, select: select.checkIn, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take })) }
    case "createCheckIn": {
      await requireKeyResult(prisma, workspaceId, id)
      return serialize(await prisma.$transaction(async (tx) => {
        const created = await tx.checkIn.create({ data: { keyResultId: id, value: Number(body.value), note: nullable(body.note), source: "API" }, select: select.checkIn })
        const updated = await tx.keyResult.updateMany({ where: { id, objective: { workspaceId } }, data: { current: Number(body.value), updatedAt: new Date(), source: "API" } })
        if (!updated.count) throw new RestNotFoundError()
        return created
      }))
    }

    case "listExperiments": return listPage(`experiments:${workspaceId}:${filters(input.query, ["status", "squadId", "assumptionId"])}`, input.query, (cursor, take) => prisma.experiment.findMany({ where: { workspaceId, ...pick(input.query, ["status", "squadId", "assumptionId"]), ...cursorWhere(cursor) }, select: select.experiment, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take }))
    case "getExperiment": return serialize(found(await prisma.experiment.findFirst({ where: { id, workspaceId }, select: select.experiment })))
    case "createExperiment": { await validateExperimentRefs(prisma, workspaceId, body); return serialize(await prisma.experiment.create({ data: { workspaceId, squadId: nullable(body.squadId) ?? null, assumptionId: nullable(body.assumptionId) ?? null, title: String(body.title), hypothesis: String(body.hypothesis), method: String(body.method), killCondition: String(body.killCondition), source: "API" }, select: select.experiment })) }
    case "updateExperiment": {
      if (!(await prisma.experiment.findFirst({ where: { id, workspaceId }, select: { id: true } }))) throw new RestNotFoundError()
      const expectedUpdatedAt = String(body.expectedUpdatedAt), fields = pick(body, ["title", "hypothesis", "method", "killCondition"])
      try { ensureTool(await updateExperiment({ experimentId: id, expectedUpdatedAt, ...fields })) }
      catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "P2025") throw new RestConflictError("The experiment changed since it was read."); throw error }
      return serialize(found(await prisma.experiment.findFirst({ where: { id, workspaceId }, select: select.experiment })))
    }
    case "listExperimentResults": { await requireExperiment(prisma, workspaceId, id); return listPage(`experiment-results:${workspaceId}:${id}`, input.query, (cursor, take) => prisma.experimentResult.findMany({ where: { experimentId: id, experiment: { workspaceId }, ...cursorWhere(cursor) }, select: select.experimentResult, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take })) }
    case "createExperimentResult": {
      await requireExperiment(prisma, workspaceId, id)
      return serialize(await captureWorkspaceMutation(prisma, "experimentResult", "create", mutationActor, undefined, tx => tx.experimentResult.create({ data: { experimentId: id, note: String(body.note), metric: nullable(body.metric), value: body.value == null ? null : Number(body.value), source: "API" }, select: select.experimentResult })))
    }
    case "concludeExperiment": {
      const conclusion = String(body.conclusion), reason = nullable(body.reason)?.trim() ?? "", expectedUpdatedAt = new Date(String(body.expectedUpdatedAt))
      if (conclusion === "NOT_PURSUED" && !reason) throw new RestConflictError("NOT_PURSUED requires a reason.")
      const status = conclusion === "KILL" ? "KILLED" : conclusion === "NOT_PURSUED" ? "NOT_PURSUED" : "COMPLETE"
      return serialize(await captureWorkspaceMutation(prisma, "experiment", "update", mutationActor, id, async tx => {
        const experiment = await tx.experiment.findFirst({ where: { id, workspaceId }, select: { id: true, status: true, assumptionId: true } })
        if (!experiment) throw new RestNotFoundError()
        if (["COMPLETE", "KILLED", "NOT_PURSUED"].includes(experiment.status)) throw new RestConflictError("The experiment is already concluded.")
        if (experiment.assumptionId && !(await tx.assumption.findFirst({ where: { id: experiment.assumptionId, solution: { workspaceId } }, select: { id: true } }))) throw new RestNotFoundError()
        const updated = await tx.experiment.updateMany({ where: { id, workspaceId, updatedAt: expectedUpdatedAt, status: { in: ["DESIGNING", "RUNNING"] } }, data: { status, conclusion, conclusionReason: reason || null, endDate: new Date(), updatedAt: new Date(Math.max(Date.now(), expectedUpdatedAt.getTime() + 1)), source: "API" } })
        if (!updated.count) throw new RestConflictError("The experiment changed since it was read.")
        if (experiment.assumptionId) {
          const assumption = await tx.assumption.updateMany({ where: { id: experiment.assumptionId, solution: { workspaceId } }, data: { status: conclusion === "PROCEED" ? "VALIDATED" : conclusion === "KILL" ? "INVALIDATED" : "UNTESTED", updatedAt: new Date(), source: "API" } })
          if (!assumption.count) throw new RestNotFoundError()
        }
        return found(await tx.experiment.findFirst({ where: { id, workspaceId }, select: select.experiment }))
      }))
    }

    case "listMetrics": return analyticsCollectionPage(`metrics:${workspaceId}`, input.query, (cursor, limit) => analyticsService.listMetricsPage(actor, workspaceId, { limit, cursor }))
    case "getMetric": return analyticsData(await handleAnalyticsTool("get_metric", { workspaceId, metricId: id }))
    case "createMetric": return analyticsData(await handleAnalyticsTool("create_metric", { workspaceId, ...body }))
    case "updateMetric": return analyticsData(await handleAnalyticsTool("update_metric", { workspaceId, metricId: id, ...body }))
    case "archiveMetric": { await analyticsData(await handleAnalyticsTool("archive_metric", { workspaceId, metricId: id })); return undefined }
    case "listMetricBindings": return analyticsCollectionPage(`metric-bindings:${workspaceId}:${filters(input.query, ["targetType", "targetId"])}`, input.query, (cursor, limit) => analyticsService.listBindingsPage(actor, workspaceId, { targetType: String(input.query.targetType) as "EXPERIMENT" | "ROADMAP_ITEM" | "KEY_RESULT", targetId: String(input.query.targetId) }, { limit, cursor }))
    case "getMetricBinding": return analyticsData(await handleAnalyticsTool("get_metric_binding", { workspaceId, bindingId: id }))
    case "createMetricBinding": return analyticsData(await handleAnalyticsTool("link_metric", { workspaceId, ...body }))
    case "updateMetricBinding": return analyticsData(await handleAnalyticsTool("update_metric_binding", { workspaceId, bindingId: id, ...body }))
    case "deleteMetricBinding": { await analyticsData(await handleAnalyticsTool("unlink_metric", { workspaceId, bindingId: id })); return undefined }
    case "refreshMetricBinding": return analyticsData(await handleAnalyticsTool("refresh_metric_binding", { workspaceId, bindingId: id, requestId: body.requestId }))
    case "listMetricObservations": return analyticsCollectionPage(`metric-observations:${workspaceId}:${id}`, input.query, (cursor, limit) => analyticsService.listObservationsPage(actor, workspaceId, id, { limit, cursor }))
    case "getMetricObservation": return analyticsData(await handleAnalyticsTool("get_metric_observation", { workspaceId, observationId: id }))

    case "listScoringModels": {
      const org = await workspaceOrganization(prisma, workspaceId)
      const data = ensureTool(await listScoringModels({ orgSlug: org.slug })) as { items: Array<{ id: string }> }
      const allowedIds = data.items.map((item) => item.id)
      return listPage(`scoring-models:${workspaceId}`, input.query, (cursor, take) => prisma.scoringModel.findMany({ where: { id: { in: allowedIds }, organizationId: org.id, ...cursorWhere(cursor) }, select: select.scoringModel, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take }))
    }
    case "getScoringModel": { await assertScoringModelAccess(actor, id); const model = await prisma.scoringModel.findFirst({ where: { id, organization: { workspaces: { some: { id: workspaceId } } } }, select: select.scoringModel }); return serialize(found(model)) }
    case "createScoringModel": { const org = await workspaceOrganization(prisma, workspaceId); await assertOrgAdminBySlug(actor, org.slug, { agentCapability: "SCORING_MODEL_ADMIN" }); const result = ensureTool(await createScoringModel({ orgSlug: org.slug, ...(body as unknown as Omit<Parameters<typeof createScoringModel>[0], "orgSlug">) })) as { id: string }; return serialize(found(await prisma.scoringModel.findFirst({ where: { id: result.id, organizationId: org.id }, select: select.scoringModel }))) }
    case "updateScoringModel": { const org = await workspaceOrganization(prisma, workspaceId); const access = await assertScoringModelAccess(actor, id, { admin: true, agentCapability: "SCORING_MODEL_ADMIN" }); if (access.organizationId !== org.id) throw new RestNotFoundError(); ensureTool(await updateScoringModel({ scoringModelId: id, ...(body as unknown as Omit<Parameters<typeof updateScoringModel>[0], "scoringModelId">) })); return serialize(found(await prisma.scoringModel.findFirst({ where: { id, organizationId: org.id }, select: select.scoringModel }))) }
    case "archiveScoringModel": { const org = await workspaceOrganization(prisma, workspaceId); const access = await assertScoringModelAccess(actor, id, { admin: true, agentCapability: "SCORING_MODEL_ADMIN" }); if (access.organizationId !== org.id) throw new RestNotFoundError(); ensureTool(await archiveScoringModel({ scoringModelId: id })); return undefined }
    case "scoreOpportunity": { if (!(await prisma.opportunity.findFirst({ where: { id, workspaceId }, select: { id: true } }))) throw new RestNotFoundError(); ensureTool(await scoreOpportunity({ opportunityId: id, rawValues: body.values as Record<string, number> })); return serialize(found(await prisma.opportunityScore.findFirst({ where: { opportunityId: id, opportunity: { workspaceId } }, select: select.opportunityScore }))) }
    case "getOpportunityScore": { if (!(await prisma.opportunity.findFirst({ where: { id, workspaceId }, select: { id: true } }))) throw new RestNotFoundError(); ensureTool(await getOpportunityScore({ opportunityId: id })); return serialize(found(await prisma.opportunityScore.findFirst({ where: { opportunityId: id, opportunity: { workspaceId } }, select: select.opportunityScore }))) }
    case "scoreSolution": { if (!(await prisma.solution.findFirst({ where: { id, workspaceId }, select: { id: true } }))) throw new RestNotFoundError(); ensureTool(await scoreSolution({ solutionId: id, rawValues: body.values as Record<string, number> })); return serialize(found(await prisma.solutionScore.findFirst({ where: { solutionId: id, solution: { workspaceId } }, select: select.solutionScore }))) }
    case "getSolutionScore": { if (!(await prisma.solution.findFirst({ where: { id, workspaceId }, select: { id: true } }))) throw new RestNotFoundError(); ensureTool(await getSolutionScore({ solutionId: id })); return serialize(found(await prisma.solutionScore.findFirst({ where: { solutionId: id, solution: { workspaceId } }, select: select.solutionScore }))) }

    case "listSquads": return listPage(`squads:${workspaceId}`, input.query, (cursor, take) => prisma.squad.findMany({ where: { workspaceId, ...cursorWhere(cursor) }, select: select.squad, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take }))
    case "getSquad": return serialize(found(await prisma.squad.findFirst({ where: { id, workspaceId }, select: select.squad })))
    case "createSquad": return serialize(await prisma.squad.create({ data: { workspaceId, name: String(body.name), color: String(body.color ?? "#6366f1"), source: "API" }, select: select.squad }))
    case "updateSquad": { const updated = await prisma.squad.updateMany({ where: { id, workspaceId }, data: { ...pick(body, ["name", "color"]), source: "API" } }); if (!updated.count) throw new RestNotFoundError(); return serialize(found(await prisma.squad.findFirst({ where: { id, workspaceId }, select: select.squad }))) }
    case "listCustomFieldDefinitions": return mappedOrderedListPage(`custom-field-definitions:${workspaceId}:${filters(input.query, ["objectType"])}`, input.query,
      (cursor, take) => prisma.customFieldDefinition.findMany({
        where: { workspaceId, ...pick(input.query, ["objectType"]), ...customFieldCursorWhere(cursor, true) },
        include: { sharedOptionSet: { select: { id: true, name: true, options: true } } },
        orderBy: [{ objectType: "asc" }, { order: "asc" }, { id: "asc" }], take,
      }),
      async rows => rows.map(toCustomFieldDefinitionData))
    case "listCustomFieldValues": {
      const objectType = input.params.objectType, objectId = input.params.objectId
      await assertCustomObjectWorkspace(prisma, workspaceId, objectType, objectId)
      return mappedOrderedListPage(`custom-field-values:${workspaceId}:${objectType}:${objectId}`, input.query,
        (cursor, take) => prisma.customFieldDefinition.findMany({
          where: { workspaceId, objectType, ...customFieldCursorWhere(cursor, false) },
          include: { sharedOptionSet: { select: { id: true, name: true, options: true } } },
          orderBy: [{ order: "asc" }, { id: "asc" }], take,
        }),
        async rows => {
          if (!rows.length) return []
          const values = await prisma.customFieldValue.findMany({ where: { fieldId: { in: rows.map(row => row.id) }, objectId } })
          const byField = new Map(values.map(value => [value.fieldId, value.value as CustomFieldValue]))
          return rows.map(row => ({ ...toCustomFieldDefinitionData(row), currentValue: byField.get(row.id) ?? null }))
        })
    }
    case "setCustomFieldValue": { await assertCustomObjectWorkspace(prisma, workspaceId, input.params.objectType, input.params.objectId); await assertCustomField(prisma, workspaceId, input.params.objectType, String(body.fieldId)); ensureTool(await setCustomFieldValue({ objectType: input.params.objectType as never, objectId: input.params.objectId, fieldId: String(body.fieldId), value: body.value as never })); const values = toolItems(await getCustomFieldValues({ objectType: input.params.objectType as never, objectId: input.params.objectId })); return found(values.find((value) => value.id === body.fieldId)) }
    case "listEntityLinks": return normalizeLinks(ensureTool(await listLinksTool({ workspaceId, ...(input.query as { opportunityId?: string; objectiveId?: string; solutionId?: string; keyResultId?: string; limit?: number; cursor?: string }) })) as Record<string, unknown>)

    case "listComments": {
      await assertCommentTargetWorkspace(input.params.targetType, input.params.targetId, workspaceId)
      return listPage(`comments:${workspaceId}:${input.params.targetType}:${input.params.targetId}:${input.query.status ?? ""}`, input.query, (cursor, take) => prisma.comment.findMany({
        where: { workspaceId, targetType: input.params.targetType, targetId: input.params.targetId, ...pick(input.query, ["status"]), ...cursorWhere(cursor) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], take,
      }))
    }
    case "createComment": {
      await assertCommentTargetWorkspace(input.params.targetType, input.params.targetId, workspaceId)
      if (typeof body.parentId === "string") {
        const parent = await prisma.comment.findFirst({ where: { id: body.parentId, workspaceId, targetType: input.params.targetType, targetId: input.params.targetId }, select: { id: true } })
        if (!parent) throw new RestNotFoundError()
      }
      const author = await restCommentAuthor(prisma, actor, workspaceId)
      if (input.params.targetType === "DOC") {
        const result = await createDocCommentCore({ docId: input.params.targetId, parentId: nullable(body.parentId), body: String(body.body), ...author })
        if (!result.ok) throw new RestValidationError(result.error)
        return serialize(result.comment)
      }
      return serialize(found(await createComment({ workspaceId, targetType: input.params.targetType as never, targetId: input.params.targetId, parentId: nullable(body.parentId), body: String(body.body), ...author })))
    }
    case "getComment": { await assertCommentWorkspace(prisma, id, workspaceId); return serialize(found(await getComment(id))) }
    case "updateComment": { assertHumanCommentBodyEditor(actor); const access = await assertCommentMutation(prisma, actor, id, workspaceId); return access.targetType === "DOC" ? serialize(ensureTool(await updateDocComment({ commentId: id, body: String(body.body) }))) : serialize(found(await updateCommentBody(id, String(body.body)))) }
    case "deleteComment": { const access = await assertCommentMutation(prisma, actor, id, workspaceId); if (access.targetType === "DOC") ensureTool(await deleteDocComment({ commentId: id })); else { const { deleteBrowserComment } = await import("@/lib/comment-browser"); await deleteBrowserComment(id, { userId: access.userId, admin: access.admin }, access.admin) } return undefined }
    case "resolveComment": { const access = await assertCommentMutation(prisma, actor, id, workspaceId); return access.targetType === "DOC" ? serialize(ensureTool(await resolveDocComment({ commentId: id }))) : serialize(found(await setCommentStatus(id, "RESOLVED"))) }
    case "reopenComment": { const access = await assertCommentMutation(prisma, actor, id, workspaceId); return access.targetType === "DOC" ? serialize(ensureTool(await reopenDocComment({ commentId: id }))) : serialize(found(await setCommentStatus(id, "OPEN"))) }
    case "followResource": return serialize(ensureTool(await followTool({ workspaceId, subjectType: input.params.subjectType, subjectId: input.params.subjectId })))
    case "unfollowResource": { ensureTool(await unfollowTool({ workspaceId, subjectType: input.params.subjectType, subjectId: input.params.subjectId })); return undefined }
    case "listNotifications": { if (!actor.userId || actor.purpose === "AGENT" || actor.purpose === "AGENT_TURN" || isServiceActor(actor)) throw new RestNotFoundError(); return notificationPage(actor.userId, workspaceId, input.query) }
    case "markNotificationsRead": return serialize(ensureTool(await markReadTool({ workspaceId, notificationIds: body.notificationIds as string[] | undefined, all: body.all as boolean | undefined })))

    case "listDocs": return listPage(`docs:${workspaceId}`, input.query, async (cursor, take) => (await prisma.doc.findMany({ where: { workspaceId, ...cursorWhere(cursor) }, select: { id: true, workspaceId: true, title: true, parentId: true, icon: true, docType: true, roadmapItemId: true, revision: true, createdAt: true, updatedAt: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take })).map(doc => ({ ...doc, revision: documentRevision(doc) })))
    case "getDoc": { await assertDocWorkspace(prisma, id, workspaceId); return serialize(ensureTool(await getDoc({ docId: id }))) }
    case "createDoc": { await assertDocReferences(prisma, workspaceId, body); return serialize(ensureTool(await createDoc({ workspaceId, ...(body as unknown as Omit<Parameters<typeof createDoc>[0], "workspaceId">) }))) }
    case "updateDoc": { await assertDocWorkspace(prisma, id, workspaceId); return serialize(ensureTool(await updateDoc({ docId: id, ...(body as unknown as Omit<Parameters<typeof updateDoc>[0], "docId">) }))) }
    case "prepareDocImageUpload": { await assertDocWorkspace(prisma, id, workspaceId); return serialize(ensureTool(await prepareDocImageUploadTool({ workspaceId, filename: String(body.filename), fileType: String(body.fileType), fileSize: Number(body.fileSize) }))) }
    case "listDocVersions": { await assertDocWorkspace(prisma, id, workspaceId); return listPage(`doc-versions:${workspaceId}:${id}`, input.query, (cursor, take) => prisma.docVersion.findMany({ where: { docId: id, ...cursorWhere(cursor) }, select: { id: true, docId: true, label: true, createdByName: true, createdAt: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take })) }
    case "createDocVersion": { await assertDocWorkspace(prisma, id, workspaceId); return serialize(ensureTool(await createDocVersion({ docId: id, label: body.label as string | undefined, authorName: await restActorName(prisma, actor), expectedRevision: body.expectedRevision as string | undefined, operationId: body.operationId as string | undefined }))) }
    case "getDocVersion": { await assertDocVersionWorkspace(prisma, id, workspaceId); return serialize(ensureTool(await getDocVersion({ versionId: id }))) }
    case "restoreDocVersion": { await assertDocVersionWorkspace(prisma, id, workspaceId); return serialize(ensureTool(await restoreDocVersion({ versionId: id, expectedRevision: body.expectedRevision as string | undefined, operationId: body.operationId as string | undefined }))) }
    case "listDocComments": { await assertDocWorkspace(prisma, id, workspaceId); return listPage(`doc-comments:${workspaceId}:${id}:${input.query.status ?? ""}`, input.query, (cursor, take) => prisma.docComment.findMany({ where: { docId: id, ...pick(input.query, ["status"]), ...cursorWhere(cursor) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take })) }
    case "createDocComment": { await assertDocWorkspace(prisma, id, workspaceId); const author = await restCommentAuthor(prisma, actor, workspaceId); const result = await createDocCommentCore({ docId: id, body: String(body.body), ...author, parentId: body.parentId as string | undefined, anchorText: body.anchorText as string | undefined, anchorPrefix: body.anchorPrefix as string | undefined, anchorSuffix: body.anchorSuffix as string | undefined, anchorStart: body.anchorStart as number | undefined, anchorEnd: body.anchorEnd as number | undefined }); if (!result.ok) throw new RestValidationError(result.error); return serialize(result.comment) }
    case "getDocComment": { await assertDocCommentWorkspace(prisma, id, workspaceId); return serialize(ensureTool(await getDocComment({ commentId: id }))) }
    case "updateDocComment": { assertHumanCommentBodyEditor(actor); await assertDocCommentMutation(prisma, actor, id, workspaceId); return serialize(ensureTool(await updateDocComment({ commentId: id, body: String(body.body) }))) }
    case "deleteDocComment": { await assertDocCommentMutation(prisma, actor, id, workspaceId); ensureTool(await deleteDocComment({ commentId: id })); return undefined }
    case "resolveDocComment": { await assertDocCommentMutation(prisma, actor, id, workspaceId); return serialize(ensureTool(await resolveDocComment({ commentId: id }))) }
    case "reopenDocComment": { await assertDocCommentMutation(prisma, actor, id, workspaceId); return serialize(ensureTool(await reopenDocComment({ commentId: id }))) }

    case "listArtifacts": return listPage(`artifacts:${workspaceId}:${Boolean(input.query.includeArchived)}`, input.query, (cursor, take) => prisma.artifact.findMany({ where: { workspaceId, ...(input.query.includeArchived ? {} : { status: "ACTIVE" }), ...cursorWhere(cursor) }, select: { id: true, workspaceId: true, title: true, description: true, sourceType: true, status: true, currentRevisionId: true, createdAt: true, updatedAt: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take }))
    case "getArtifact": { await assertArtifactWorkspace(prisma, id, workspaceId); return serialize(ensureTool(await getArtifact({ artifactId: id }))) }
    case "createArtifact": return serialize(ensureTool(await createArtifact({ workspaceId, ...(body as unknown as Omit<Parameters<typeof createArtifact>[0], "workspaceId">) })))
    case "updateArtifact": { await assertArtifactWorkspace(prisma, id, workspaceId); ensureTool(await updateArtifact({ artifactId: id, workspaceId, ...body } as Parameters<typeof updateArtifact>[0])); return serialize(ensureTool(await getArtifact({ artifactId: id }))) }
    case "archiveArtifact": { await assertArtifactWorkspace(prisma, id, workspaceId); ensureTool(await archiveArtifact({ artifactId: id, workspaceId })); return undefined }
    case "linkArtifactSolution": { await assertArtifactWorkspace(prisma, id, workspaceId); await assertSolutionWorkspace(prisma, String(body.solutionId), workspaceId); return serialize(ensureTool(await linkArtifact({ artifactId: id, solutionId: String(body.solutionId), workspaceId }))) }
    case "unlinkArtifactSolution": { await assertArtifactWorkspace(prisma, id, workspaceId); await assertSolutionWorkspace(prisma, input.params.relatedId, workspaceId); ensureTool(await unlinkArtifact({ artifactId: id, solutionId: input.params.relatedId, workspaceId })); return undefined }
    case "linkArtifactDecision": { await assertArtifactWorkspace(prisma, id, workspaceId); await assertReviewWorkspace(prisma, String(body.requestId), workspaceId); return serialize(ensureTool(await linkArtifactDecision({ artifactId: id, requestId: String(body.requestId), workspaceId }))) }
    case "unlinkArtifactDecision": { await assertArtifactWorkspace(prisma, id, workspaceId); await assertReviewWorkspace(prisma, input.params.relatedId, workspaceId); ensureTool(await unlinkArtifactDecision({ artifactId: id, requestId: input.params.relatedId, workspaceId })); return undefined }

    case "requestDecision": { await assertDecisionReferences(prisma, workspaceId, body); return serialize(ensureTool(await requestDecision({ workspaceId, ...(body as unknown as Omit<Parameters<typeof requestDecision>[0], "workspaceId">), idempotencyKey: String(body.idempotencyKey ?? crypto.randomUUID()) }))) }
    case "listDecisions": return pagedToolCollection(`decisions:${workspaceId}:${input.query.status ?? ""}`, input.query, async (page, pageSize) => { const data = ensureTool(await listDecisions({ workspaceId, state: input.query.status as never, page, pageSize })) as { requests?: unknown[]; total?: number }; return { items: data.requests ?? [], total: data.total ?? 0 } })
    case "getDecision": { await assertReviewWorkspace(prisma, id, workspaceId); return serialize(ensureTool(await getDecision({ workspaceId, requestId: id }))) }
    case "listReviewRequests": return listPage(`review-requests:${workspaceId}:${input.query.state ?? ""}`, input.query, (cursor, take) => prisma.reviewRequest.findMany({ where: { workspaceId, ...pick(input.query, ["state"]), ...cursorWhere(cursor) }, select: { id: true, workspaceId: true, gateType: true, subjectType: true, subjectId: true, state: true, createdAt: true, updatedAt: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take }))
    case "getReviewRequest": { await assertReviewWorkspace(prisma, id, workspaceId); return serialize(ensureTool(await getReviewRequest({ requestId: id }))) }
    case "listSolutionPlanEntries": { await assertSolutionWorkspace(prisma, id, workspaceId); return listPage(`solution-plans:${workspaceId}:${id}`, input.query, (cursor, take) => prisma.solutionComment.findMany({ where: { solutionId: id, ...cursorWhere(cursor) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take })) }
    case "createSolutionPlan": { await assertSolutionWorkspace(prisma, id, workspaceId); const agent = actor.purpose === "AGENT" || actor.purpose === "AGENT_TURN"; return serialize(ensureTool(await addSolutionPlan({ solutionId: id, body: String(body.body), authorName: await restActorName(prisma, actor), authorType: agent ? "AGENT" : "HUMAN", source: agent ? "MCP" : "UI" }))) }
    case "createSolutionPlanComment": { await assertSolutionWorkspace(prisma, id, workspaceId); const agent = actor.purpose === "AGENT" || actor.purpose === "AGENT_TURN"; return serialize(ensureTool(await addSolutionComment({ solutionId: id, body: String(body.body), authorName: await restActorName(prisma, actor), authorType: agent ? "AGENT" : "HUMAN" }))) }
    case "getSolutionPlanEntry": { await assertSolutionPlanWorkspace(prisma, id, workspaceId); return serialize(ensureTool(await getSolutionComment({ commentId: id }))) }
    case "updateSolutionPlanEntry": { await assertSolutionPlanWorkspace(prisma, id, workspaceId); await assertWorkspaceAdmin(actor, workspaceId); return serialize(ensureTool(await updateSolutionComment({ commentId: id, body: String(body.body) }))) }
    case "deleteSolutionPlanEntry": { await assertSolutionPlanWorkspace(prisma, id, workspaceId); await assertWorkspaceAdmin(actor, workspaceId); ensureTool(await deleteSolutionComment({ commentId: id })); return undefined }
    case "setLaunchTier": { await assertRoadmapWorkspace(prisma, id, workspaceId); return serialize(ensureTool(await setLaunchTier({ itemId: id, tier: body.tier as never }))) }
    case "getLaunchChecklist": { await assertRoadmapWorkspace(prisma, id, workspaceId); return serialize(ensureTool(await getLaunchChecklist({ roadmapItemId: id }))) }
    case "updateLaunchChecklistItem": { if (!(await prisma.launchChecklistItem.findFirst({ where: { id, launchChecklist: { roadmapItem: { workspaceId } } }, select: { id: true } }))) throw new RestNotFoundError(); return serialize(ensureTool(await updateLaunchChecklistItem({ itemId: id, status: body.status as never }))) }
    case "requestReleaseAuthorization": { if (actor.purpose !== "USER" || !actor.userId) throw new RestNotFoundError(); await assertWorkspaceAdmin(actor, workspaceId); const taskIds = body.taskIds as string[]; if (await prisma.task.count({ where: { workspaceId, id: { in: taskIds } } }) !== new Set(taskIds).size) throw new RestNotFoundError(); return serialize(ensureTool(await requestReleaseAuthorization({ workspaceId, ...(body as unknown as Omit<Parameters<typeof requestReleaseAuthorization>[0], "workspaceId">) }))) }
    case "listReleaseRuns": { const releaseFilters = filters(input.query, ["state", "taskId", "updatedSince"]); const page = await listUpdatedPage(`release-runs:${workspaceId}:${releaseFilters}`, input.query, (cursor, take) => prisma.releaseRun.findMany({ where: { workspaceId, ...(input.query.state ? { state: String(input.query.state) } : {}), ...(input.query.taskId ? { tasks: { some: { taskId: String(input.query.taskId) } } } : {}), ...(input.query.updatedSince ? { updatedAt: { gte: new Date(String(input.query.updatedSince)) } } : {}), ...updatedCursorWhere(cursor) }, select: { id: true, state: true, provider: true, repositoryOwner: true, repositoryName: true, pullRequestNumber: true, baseRef: true, headSha: true, targetEnvironment: true, releasePolicyId: true, sourceFingerprint: true, authorizationDecisionRecordId: true, lastErrorCode: true, createdAt: true, updatedAt: true, tasks: { select: { taskId: true }, orderBy: { taskId: "asc" } }, dispatches: { select: { id: true, status: true, updatedAt: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] } }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take })); return { ...page, items: page.items.map((value) => { const row = value as Record<string, unknown> & { tasks?: Array<{ taskId: string }> }; const { tasks, ...safe } = row; return { ...safe, taskIds: (tasks ?? []).map(task => task.taskId), pullRequestUrl: `https://github.com/${row.repositoryOwner}/${row.repositoryName}/pull/${row.pullRequestNumber}` } }) } }
    case "listResearchStudies": return researchCall(async () => { const page = await researchStudies.listResearchStudies({ workspaceId }, researchActor(actor), input.query as never); return { items: page.items.map(serialize), nextCursor: page.nextCursor } })
    case "createResearchStudy": return researchCall(async () => { const created = await researchStudies.createResearchStudy({ workspaceId }, researchActor(actor), { ...body, status: "DRAFT" } as never); return serialize(await researchStudies.getResearchStudy({ workspaceId }, researchActor(actor), created.id)) })
    case "getResearchStudy": return researchCall(async () => serialize(await researchStudies.getResearchStudy({ workspaceId }, researchActor(actor), id)))
    case "updateResearchStudy": return researchCall(async () => { await researchStudies.updateResearchStudy({ workspaceId }, researchActor(actor), id, body as never); return serialize(await researchStudies.getResearchStudy({ workspaceId }, researchActor(actor), id)) })
    case "activateResearchStudy": return researchCall(async () => participantCredentialAction(() => researchStudies.activateResearchStudy({ workspaceId }, researchActor(actor), id)))
    case "closeResearchStudy": return researchCall(async () => participantLinkResult(await researchStudies.closeResearchStudy({ workspaceId }, researchActor(actor), id)))
    case "archiveResearchStudy": return researchCall(async () => participantLinkResult(await researchStudies.archiveResearchStudy({ workspaceId }, researchActor(actor), id)))
    case "issueResearchParticipantLink": return researchCall(async () => participantCredentialAction(() => researchStudies.issueResearchLink({ workspaceId }, researchActor(actor), id)))
    case "rotateResearchParticipantLink": return researchCall(async () => participantCredentialAction(() => researchStudies.regenerateResearchLink({ workspaceId }, researchActor(actor), id)))
    case "revokeResearchParticipantLinks": return researchCall(async () => participantLinkResult(await researchStudies.revokeResearchLinks({ workspaceId }, researchActor(actor), id)))
    case "listResearchSessions": { const limit = Number(input.query.limit ?? 50); return researchOffsetPage(`research-sessions:${workspaceId}:${id}:${input.query.status ?? "all"}:limit:${limit}`, input.query, offset => researchStudies.listResearchSessions({ workspaceId }, researchActor(actor), id, { status: input.query.status as researchStudies.ResearchSessionStatus | undefined, offset, limit })) }
    case "getResearchSession": return researchCall(async () => { const limit = Number(input.query.limit ?? 50); const context = `research-session:${workspaceId}:${id}:${input.params.relatedId}:limit:${limit}`; const offset = restOffset(input.query.cursor, context); const result = await researchStudies.getResearchSession({ workspaceId }, researchActor(actor), id, input.params.relatedId, { offset, limit }); const { nextOffset, ...safe } = result; return { ...serialize(safe) as Record<string, unknown>, nextCursor: nextOffset === null ? null : signedOffset(nextOffset, context) } })
    case "listResearchSyntheses": { const limit = Number(input.query.limit ?? 50); return researchSynthesisPage(`research-syntheses:${workspaceId}:${id}:limit:${limit}`, input.query, offset => researchStudies.listResearchSyntheses({ workspaceId }, researchActor(actor), id, { offset, limit })) }
    case "createResearchSynthesis": { if (!actor.userId) throw new RestNotFoundError(); return researchCall(async () => { await researchStudies.getResearchStudy({ workspaceId }, researchActor(actor), id); return publicSynthesis(await storeAgentStudySynthesis(id, actor.userId!, body)) }) }
    case "promoteResearchEvidence": return researchCall(async () => { const result = await promoteResearchFindingToEvidence({ workspaceId, researchSynthesisId: id, ...body } as never); return serialize({ id: result.evidence.id, findingKey: result.findingKey, researchSynthesisId: result.evidence.researchSynthesisId, sourceTurnIds: result.sourceTurnIds, opportunityId: result.evidence.opportunityId, solutionId: result.evidence.solutionId, assumptionId: result.evidence.assumptionId, replayed: result.replayed }) })
    case "getPmInterview": { if (actor.purpose !== "USER" || !actor.userId) throw new RestNotFoundError(); try { return serialize(await readOwnedPmInterview(await workspaceSlugScope(prisma, workspaceId), { userId: actor.userId }, id)) } catch (error) { if (error instanceof PmInterviewError) { if (error.status === 404) throw new RestNotFoundError(); if (error.status === 409) throw new RestConflictError(error.message); throw new RestValidationError(error.message) } throw error } }
    case "listAnalyticsConnections": return arrayPage(`analytics-connections:${workspaceId}`, input.query, await analyticsService.listConnections(actor, workspaceId))
    case "saveAnalyticsConnection": return serialize(await analyticsService.saveVercelConnection(actor, workspaceId, { projectId: String(body.projectId), teamId: body.teamId as string | undefined, token: String(body.token) }))
    case "disconnectAnalyticsConnection": { await analyticsService.disconnectConnection(actor, workspaceId, id); return undefined }
    case "listCardSortFactors": return arrayPage(`card-sort-factors:${workspaceId}:${input.query.objectType}`, input.query, await cardSortCall(() => listCardSortFactors({ workspaceId, objectType: String(input.query.objectType) as never })))
    case "listCardSortRounds": return arrayPage(`card-sort-rounds:${workspaceId}:${input.query.state ?? "all"}`, input.query, await cardSortCall(() => listCardSortRounds({ workspaceId, userId: humanUser(actor), state: input.query.state as never })))
    case "createCardSortRound": return serialize(await cardSortCall(() => createCardSortRound({ workspaceId, userId: humanUser(actor), name: String(body.name), fieldDefinitionId: String(body.fieldDefinitionId) })))
    case "revealCardSortRound": { const userId = humanUser(actor); await cardSortCall(() => setCardSortRoundState({ workspaceId, roundId: id, userId, state: "REVEALED" })); return serialize(found((await listCardSortRounds({ workspaceId, userId })).find(round => round.id === id))) }
    case "closeCardSortRound": { const userId = humanUser(actor); await cardSortCall(() => setCardSortRoundState({ workspaceId, roundId: id, userId, state: "CLOSED" })); return serialize(found((await listCardSortRounds({ workspaceId, userId })).find(round => round.id === id))) }
    case "getCardSortBoard": return serialize(await cardSortCall(() => loadCardSortBoard({ workspaceId, roundId: id, userId: humanUser(actor) })))
    case "listCardSortProposals": return arrayPage(`card-sort-proposals:${workspaceId}:${id}:${humanUser(actor)}`, input.query, await cardSortCall(() => listMyCardSortProposals({ workspaceId, roundId: id, userId: humanUser(actor) })))
    case "proposeCardSortMoves": return serialize(await cardSortCall(() => proposeCardSortMoves({ workspaceId, roundId: id, userId: humanUser(actor), objectIds: body.objectIds as string[], proposedValue: String(body.proposedValue), rationale: nullable(body.rationale) })))
    case "withdrawCardSortProposal": { await cardSortCall(() => withdrawCardSortProposal({ workspaceId, roundId: id, userId: humanUser(actor), objectId: input.params.relatedId })); return undefined }
    case "getCardSortTally": return serialize(await cardSortCall(() => getCardSortTally({ workspaceId, roundId: id, userId: humanUser(actor) })))
    case "listCardSortNewEntries": return arrayPage(`card-sort-new-entries:${workspaceId}:${id}:${humanUser(actor)}`, input.query, await cardSortCall(() => listCardSortNewEntries({ workspaceId, roundId: id, userId: humanUser(actor) })))
    case "proposeCardSortNewEntry": { const userId = humanUser(actor); const created = await cardSortCall(() => proposeCardSortNewEntry({ workspaceId, roundId: id, userId, title: String(body.title), description: nullable(body.description), suggestedValue: nullable(body.suggestedValue) })); return serialize(found((await listCardSortNewEntries({ workspaceId, roundId: id, userId })).find(entry => entry.id === created.id))) }
    case "withdrawCardSortNewEntry": { await cardSortCall(() => withdrawCardSortNewEntry({ workspaceId, roundId: id, userId: humanUser(actor), entryId: input.params.relatedId })); return undefined }
    case "acceptCardSortNewEntry": return serialize(await cardSortCall(() => acceptCardSortNewEntry({ workspaceId, roundId: id, userId: humanUser(actor), entryId: input.params.relatedId })))
    case "rejectCardSortNewEntry": return serialize(await cardSortCall(() => rejectCardSortNewEntry({ workspaceId, roundId: id, userId: humanUser(actor), entryId: input.params.relatedId, note: nullable(body.note) })))
  }
  throw new RestNotFoundError()
}

async function enforcePolicy(policy: RestAuthorizationPolicy, actor: ReturnType<typeof getMcpActor>, workspaceId?: string) {
  switch (policy) {
    case "authenticated-actor":
    case "accessible-workspaces":
      return
    case "workspace-member":
    case "workspace-writer":
      if (!workspaceId) throw new RestNotFoundError()
      await assertWorkspaceMember(actor, workspaceId)
      return
    case "human-member":
      if (!workspaceId || actor.purpose !== "USER" || !actor.userId) throw new RestForbiddenError()
      await assertWorkspaceMember(actor, workspaceId)
      return
    case "human-admin":
      if (!workspaceId || actor.purpose !== "USER" || !actor.userId) throw new RestForbiddenError()
      await assertWorkspaceAdmin(actor, workspaceId)
      return
    default:
      throw new RestNotFoundError()
  }
}

function researchActor(actor: ReturnType<typeof getMcpActor>): researchStudies.ResearchStudyActor {
  return { userId: actor.userId, service: isServiceActor(actor), source: "API" }
}

async function researchCall<T>(run: () => Promise<T>): Promise<T> {
  try { return await run() } catch (error) {
    if (error instanceof researchStudies.ResearchCursorError) throw new RestCursorError(error.message)
    if (error instanceof ResearchAnalysisError || error instanceof ResearchPromotionError) {
      if (error.status === 404) throw new RestNotFoundError()
      if (error.status === 409) throw new RestConflictError(error.message)
      throw new RestValidationError(error.message)
    }
    if (error instanceof researchStudies.ResearchStudyError) {
      if (/not found|workspace|unauthorized/i.test(error.message)) throw new RestNotFoundError()
      if (/changed|already|archived|active study|draft or closed|lifecycle/i.test(error.message)) throw new RestConflictError(error.message)
      throw new RestValidationError(error.message)
    }
    throw error
  }
}

function participantLinkResult(result: { id: string; status?: string; token?: string }) {
  const participantUrl = result.token ? researchParticipantUrl(result.token) : null
  return { id: result.id, ...(result.status ? { status: result.status } : {}), participantUrl }
}

async function participantCredentialAction(run: () => Promise<{ id: string; status?: string; token?: string }>) {
  // Validate the disclosure channel before minting a one-time credential. A
  // missing/unsafe deployment origin must not consume a token the caller can
  // never retrieve again.
  researchParticipantUrl("configuration-check")
  return participantLinkResult(await run())
}

function restOffset(value: unknown, context: string): number {
  if (value === undefined) return 0
  const cursor = typeof value === "string" ? decodeCursor(value, context) : null
  const offset = cursor ? Number(cursor.id.replace(/^offset:/, "")) : Number.NaN
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RestCursorError("The cursor is invalid for this collection or filter set.")
  return offset
}

function signedOffset(offset: number, context: string) {
  return encodeCursor({ id: `offset:${offset}`, createdAt: new Date(0).toISOString(), context })
}

function arrayPage<T>(context: string, query: Record<string, unknown>, rows: T[]) {
  const offset = restOffset(query.cursor, context)
  const limit = Number(query.limit ?? 50)
  return { items: rows.slice(offset, offset + limit).map(serialize), nextCursor: rows.length > offset + limit ? signedOffset(offset + limit, context) : null }
}

async function researchOffsetPage<T extends { items: unknown[]; nextOffset: number | null }>(context: string, query: Record<string, unknown>, load: (offset: number) => Promise<T>) {
  return researchCall(async () => { const page = await load(restOffset(query.cursor, context)); return { items: page.items.map(serialize), nextCursor: page.nextOffset === null ? null : signedOffset(page.nextOffset, context) } })
}

function publicSynthesis(value: unknown) {
  if (!value || typeof value !== "object") throw new RestValidationError("The synthesis result was invalid.")
  const row = value as Record<string, unknown>
  return serialize({ summary: row.summary, themes: row.themes, patterns: row.patterns, jobs: row.jobs, recommendations: row.recommendations })
}

async function researchSynthesisPage<T extends { items: Array<Record<string, unknown>>; nextOffset: number | null }>(context: string, query: Record<string, unknown>, load: (offset: number) => Promise<T>) {
  return researchCall(async () => { const page = await load(restOffset(query.cursor, context)); return { items: page.items.map(item => serialize({ id: item.id, sessionCount: item.sessionCount, createdAt: item.createdAt, content: item.content ? publicSynthesis(item.content) : null })), nextCursor: page.nextOffset === null ? null : signedOffset(page.nextOffset, context) } })
}

async function workspaceSlugScope(prisma: Prisma, workspaceId: string) {
  const workspace = await prisma.workspace.findFirst({ where: { id: workspaceId }, select: { slug: true, organization: { select: { slug: true } } } })
  if (!workspace) throw new RestNotFoundError()
  return { orgSlug: workspace.organization.slug, workspaceSlug: workspace.slug }
}

async function cardSortCall<T>(run: () => Promise<T>): Promise<T> {
  try { return await run() } catch (error) {
    if (!(error instanceof CardSortError)) throw error
    const status = CARD_SORT_ERROR_STATUS[error.code]
    if (status === 404) throw new RestNotFoundError()
    if (status === 403) throw new RestForbiddenError(error.message)
    if (status === 409) throw new RestConflictError(error.message)
    throw new RestBadRequestError(error.message)
  }
}

function humanUser(actor: ReturnType<typeof getMcpActor>): string {
  if (actor.purpose !== "USER" || !actor.userId) throw new RestForbiddenError()
  return actor.userId
}

async function listPage(context: string, query: Record<string, unknown>, load: (cursor: { id: string; createdAt: string } | null, take: number) => Promise<unknown[]>): Promise<{ items: unknown[]; nextCursor: string | null }> {
  const limit = Number(query.limit ?? 50)
  const cursor = typeof query.cursor === "string" ? decodeCursor(query.cursor, context) : null
  if (query.cursor && !cursor) throw new RestCursorError("The cursor is invalid for this collection or filter set.")
  const rows = await load(cursor, limit + 1) as Array<Record<string, unknown>>
  const hasMore = rows.length > limit
  const items = rows.slice(0, limit).map(serialize) as Array<Record<string, unknown>>
  const last = items.at(-1)
  return { items, nextCursor: hasMore && last ? encodeCursor({ id: String(last.id), createdAt: String(last.createdAt), context }) : null }
}

async function listUpdatedPage(context: string, query: Record<string, unknown>, load: (cursor: { id: string; createdAt: string } | null, take: number) => Promise<unknown[]>): Promise<{ items: unknown[]; nextCursor: string | null }> {
  const limit = Number(query.limit ?? 50)
  const cursor = typeof query.cursor === "string" ? decodeCursor(query.cursor, context) : null
  if (query.cursor && !cursor) throw new RestCursorError("The cursor is invalid for this collection or filter set.")
  const rows = await load(cursor, limit + 1) as Array<Record<string, unknown>>
  const items = rows.slice(0, limit).map(serialize) as Array<Record<string, unknown>>
  const last = items.at(-1)
  return { items, nextCursor: rows.length > limit && last ? encodeCursor({ id: String(last.id), createdAt: String(last.updatedAt), context }) : null }
}

async function pagedToolCollection(context: string, query: Record<string, unknown>, load: (page: number, pageSize: number) => Promise<{ items: unknown[]; total: number }>) {
  const limit = Number(query.limit ?? 50)
  const cursorContext = `${context}:limit:${limit}`
  const cursor = typeof query.cursor === "string" ? decodeCursor(query.cursor, cursorContext) : null
  if (query.cursor && !cursor) throw new RestCursorError("The cursor is invalid for this collection or filter set.")
  const page = cursor ? Number(cursor.id.replace(/^page:/, "")) : 1
  if (!Number.isInteger(page) || page < 1) throw new RestCursorError("The cursor is invalid for this collection or filter set.")
  const result = await load(page, limit)
  const hasMore = page * limit < result.total
  return { items: result.items.map(serialize), nextCursor: hasMore ? encodeCursor({ id: `page:${page + 1}`, createdAt: new Date(0).toISOString(), context: cursorContext }) : null }
}

async function notificationPage(userId: string, workspaceId: string, query: Record<string, unknown>) {
  const context = `notifications:${workspaceId}:${userId}:${Boolean(query.unreadOnly)}`
  const limit = Number(query.limit ?? 50)
  const decoded = typeof query.cursor === "string" ? decodeCursor(query.cursor, context) : null
  if (query.cursor && !decoded) throw new RestCursorError("The cursor is invalid for this inbox or filter set.")
  let serviceCursor = decoded ? Buffer.from(`${decoded.createdAt}|${decoded.id}`).toString("base64url") : undefined
  const items: unknown[] = []
  for (let pageNumber = 0; pageNumber < 100 && items.length < limit; pageNumber += 1) {
    const page = await listNotifications(userId, workspaceId, { limit: limit - items.length, cursor: serviceCursor, unreadOnly: Boolean(query.unreadOnly) })
    items.push(...page.items.map(serialize))
    serviceCursor = page.nextCursor ?? undefined
    if (!serviceCursor) break
  }
  const next = serviceCursor ? Buffer.from(serviceCursor, "base64url").toString().split("|") : null
  const unread = await unreadCount(userId, workspaceId)
  return {
    items,
    nextCursor: next?.[0] && next[1] ? encodeCursor({ id: next[1], createdAt: next[0], context }) : null,
    unreadCount: unread.count,
    unreadOverflow: unread.overflow,
  }
}

async function mappedOrderedListPage<T extends { id: string; objectType: string; order: number }>(
  context: string,
  query: Record<string, unknown>,
  load: (cursor: OrderedCursorPayload | null, take: number) => Promise<T[]>,
  map: (rows: T[]) => Promise<unknown[]>,
): Promise<{ items: unknown[]; nextCursor: string | null }> {
  const limit = Number(query.limit ?? 50)
  const cursor = typeof query.cursor === "string" ? decodeOrderedCursor(query.cursor, context) : null
  if (query.cursor && !cursor) throw new RestCursorError("The cursor is invalid for this collection or filter set.")
  const rows = await load(cursor, limit + 1)
  const selected = rows.slice(0, limit)
  const last = selected.at(-1)
  return {
    items: await map(selected),
    nextCursor: rows.length > limit && last ? encodeOrderedCursor({ id: last.id, objectType: last.objectType as OrderedCursorPayload["objectType"], order: last.order, context }) : null,
  }
}

function customFieldCursorWhere(cursor: OrderedCursorPayload | null, includeObjectType: boolean): Record<string, unknown> {
  if (!cursor) return {}
  if (includeObjectType) {
    return { OR: [
      { objectType: { gt: cursor.objectType } },
      { objectType: cursor.objectType, order: { gt: cursor.order } },
      { objectType: cursor.objectType, order: cursor.order, id: { gt: cursor.id } },
    ] }
  }
  return { OR: [{ order: { gt: cursor.order } }, { order: cursor.order, id: { gt: cursor.id } }] }
}

function cursorWhere(cursor: { id: string; createdAt: string } | null): Record<string, unknown> {
  if (!cursor) return {}
  const createdAt = new Date(cursor.createdAt)
  return { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: cursor.id } }] }
}
function updatedCursorWhere(cursor: { id: string; createdAt: string } | null): Record<string, unknown> {
  if (!cursor) return {}
  const updatedAt = new Date(cursor.createdAt)
  return { OR: [{ updatedAt: { lt: updatedAt } }, { updatedAt, id: { lt: cursor.id } }] }
}
function found<T>(value: T | null | undefined): T { if (value == null) throw new RestNotFoundError(); return value }
function nullable(value: unknown): string | null | undefined { return value === null ? null : typeof value === "string" ? value : undefined }
function pick(source: Record<string, unknown>, keys: string[]): Record<string, unknown> { return Object.fromEntries(keys.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]])) }
function filters(query: Record<string, unknown>, keys: string[]): string { return JSON.stringify(pick(query, keys)) }
function serialize(value: unknown): unknown {
  const serialized = JSON.parse(JSON.stringify(value)) as unknown
  if (serialized && typeof serialized === "object" && "tags" in serialized) {
    const row = serialized as Record<string, unknown>
    row.tags = Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === "string") : []
  }
  return serialized
}

function ensureTool(result: ToolResult): unknown {
  if (!result.structuredContent.ok) {
    const message = result.structuredContent.message
    if (/not found|does not belong|access denied|not accessible/i.test(message)) throw new RestNotFoundError()
    if (/\b(require[sd]?|provide|invalid|must|cannot|only|expected|pass exactly)\b/i.test(message)) throw new RestValidationError(message)
    throw new RestConflictError(message)
  }
  const data = result.structuredContent.data
  return data
}

function toolItems(result: ToolResult): Array<Record<string, unknown>> {
  const data = ensureTool(result) as { items?: Array<Record<string, unknown>> }
  return data.items ?? []
}

function analyticsData(result: ToolResult): unknown {
  if (!result.structuredContent.ok) {
    if (["NOT_FOUND_OR_ACCESS_DENIED", "ACCESS_DENIED"].includes(result.structuredContent.message)) throw new RestNotFoundError()
    throw new RestConflictError("The analytics operation could not be completed.")
  }
  const data = result.structuredContent.data
  if (data && typeof data === "object" && "items" in data) return (data as { items: unknown[] }).items
  return data
}

async function analyticsCollectionPage<T>(context: string, query: Record<string, unknown>, load: (cursor: { id: string; at: Date } | null, limit: number) => Promise<analyticsService.AnalyticsPage<T>>) {
  const limit = Number(query.limit ?? 50)
  const decoded = typeof query.cursor === "string" ? decodeCursor(query.cursor, context) : null
  if (query.cursor && !decoded) throw new RestCursorError("The cursor is invalid for this collection or filter set.")
  const page = await load(decoded ? { id: decoded.id, at: new Date(decoded.createdAt) } : null, limit)
  return { items: page.items.map(serialize), nextCursor: page.next ? encodeCursor({ id: page.next.id, createdAt: page.next.at.toISOString(), context }) : null }
}

function normalizeLinks(data: Record<string, unknown>) {
  return { items: Array.isArray(data.items) ? data.items.map(serialize) : [], nextCursor: typeof data.nextCursor === "string" ? data.nextCursor : null }
}

type Prisma = ReturnType<typeof getPrisma>
function assertHumanCommentBodyEditor(actor: ReturnType<typeof getMcpActor>) {
  if (actor.purpose === "AGENT" || actor.purpose === "AGENT_TURN") throw new RestForbiddenError("An agent cannot edit comment bodies.")
}
async function restActorName(prisma: Prisma, actor: ReturnType<typeof getMcpActor>): Promise<string> {
  if ((actor.purpose === "AGENT" || actor.purpose === "AGENT_TURN") && actor.agentId) {
    const agent = await prisma.agent.findFirst({ where: { id: actor.agentId, ...(actor.userId ? { ownerUserId: actor.userId } : {}) }, select: { name: true } })
    return agent?.name ?? "Compass agent"
  }
  if (actor.userId) {
    const user = await prisma.user.findFirst({ where: { id: actor.userId }, select: { name: true, email: true } })
    return user?.name?.trim() || user?.email || "Compass user"
  }
  return "Compass service"
}
async function restCommentAuthor(prisma: Prisma, actor: ReturnType<typeof getMcpActor>, workspaceId: string) {
  await assertWorkspaceMember(actor, workspaceId)
  const agent = actor.purpose === "AGENT" || actor.purpose === "AGENT_TURN"
  return { authorId: agent ? null : actor.userId, authorName: await restActorName(prisma, actor), authorType: agent ? "AGENT" as const : "HUMAN" as const, source: agent ? "MCP" as const : "UI" as const }
}
async function assertCommentTargetWorkspace(targetType: string, targetId: string, workspaceId: string) {
  const target = await resolveCommentTarget(targetType as never, targetId)
  if (!target || target.workspaceId !== workspaceId) throw new RestNotFoundError()
}
async function assertCommentWorkspace(prisma: Prisma, commentId: string, workspaceId: string) {
  const comment = await prisma.comment.findFirst({ where: { id: commentId, workspaceId }, select: { id: true, authorId: true, targetType: true } })
  if (!comment) throw new RestNotFoundError()
  return comment
}
async function assertCommentMutation(prisma: Prisma, actor: ReturnType<typeof getMcpActor>, commentId: string, workspaceId: string) {
  const comment = await assertCommentWorkspace(prisma, commentId, workspaceId)
  if (actor.userId && comment.authorId === actor.userId) return { userId: actor.userId, admin: false, targetType: comment.targetType }
  try { await assertWorkspaceAdmin(actor, workspaceId); return { userId: actor.userId ?? "", admin: true, targetType: comment.targetType } } catch { throw new RestNotFoundError() }
}
async function assertDocWorkspace(prisma: Prisma, docId: string, workspaceId: string) {
  if (!(await prisma.doc.findFirst({ where: { id: docId, workspaceId }, select: { id: true } }))) throw new RestNotFoundError()
}
async function assertDocVersionWorkspace(prisma: Prisma, versionId: string, workspaceId: string) {
  if (!(await prisma.docVersion.findFirst({ where: { id: versionId, doc: { workspaceId } }, select: { id: true } }))) throw new RestNotFoundError()
}
async function assertDocCommentWorkspace(prisma: Prisma, commentId: string, workspaceId: string) {
  const comment = await prisma.docComment.findFirst({ where: { id: commentId, doc: { workspaceId } }, select: { id: true, authorId: true } })
  if (!comment) throw new RestNotFoundError()
  return comment
}
async function assertDocCommentMutation(prisma: Prisma, actor: ReturnType<typeof getMcpActor>, commentId: string, workspaceId: string) {
  const comment = await assertDocCommentWorkspace(prisma, commentId, workspaceId)
  if (actor.userId && comment.authorId === actor.userId) return
  try { await assertWorkspaceAdmin(actor, workspaceId) } catch { throw new RestNotFoundError() }
}
async function assertDocReferences(prisma: Prisma, workspaceId: string, body: Record<string, unknown>) {
  if (typeof body.parentId === "string") await assertDocWorkspace(prisma, body.parentId, workspaceId)
  if (typeof body.roadmapItemId === "string") await assertRoadmapWorkspace(prisma, body.roadmapItemId, workspaceId)
}
async function assertArtifactWorkspace(prisma: Prisma, artifactId: string, workspaceId: string) {
  if (!(await prisma.artifact.findFirst({ where: { id: artifactId, workspaceId }, select: { id: true } }))) throw new RestNotFoundError()
}
async function assertSolutionWorkspace(prisma: Prisma, solutionId: string, workspaceId: string) {
  if (!(await prisma.solution.findFirst({ where: { id: solutionId, workspaceId }, select: { id: true } }))) throw new RestNotFoundError()
}
async function assertReviewWorkspace(prisma: Prisma, requestId: string, workspaceId: string) {
  if (!(await prisma.reviewRequest.findFirst({ where: { id: requestId, workspaceId }, select: { id: true } }))) throw new RestNotFoundError()
}
async function assertSolutionPlanWorkspace(prisma: Prisma, entryId: string, workspaceId: string) {
  if (!(await prisma.solutionComment.findFirst({ where: { id: entryId, solution: { workspaceId } }, select: { id: true } }))) throw new RestNotFoundError()
}
async function assertRoadmapWorkspace(prisma: Prisma, itemId: string, workspaceId: string) {
  if (!(await prisma.roadmapItem.findFirst({ where: { id: itemId, workspaceId }, select: { id: true } }))) throw new RestNotFoundError()
}
async function assertDecisionReference(prisma: Prisma, workspaceId: string, type: string, id: string) {
  if (type === "WORKSPACE") { if (id !== workspaceId) throw new RestNotFoundError(); return }
  const row = type === "OPPORTUNITY" ? await prisma.opportunity.findFirst({ where: { id, workspaceId }, select: { id: true } })
      : type === "SOLUTION" ? await prisma.solution.findFirst({ where: { id, workspaceId }, select: { id: true } })
      : type === "ASSUMPTION" ? await prisma.assumption.findFirst({ where: { id, solution: { workspaceId } }, select: { id: true } })
      : type === "ROADMAP_ITEM" ? await prisma.roadmapItem.findFirst({ where: { id, workspaceId }, select: { id: true } })
        : type === "DOC" ? await prisma.doc.findFirst({ where: { id, workspaceId }, select: { id: true } })
          : type === "EXPERIMENT" ? await prisma.experiment.findFirst({ where: { id, workspaceId }, select: { id: true } })
            : type === "FEEDBACK" ? await prisma.feedbackItem.findFirst({ where: { id, workspaceId }, select: { id: true } })
              : type === "EVIDENCE" ? await prisma.evidence.findFirst({ where: { id, workspaceId }, select: { id: true } }) : null
  if (!row) throw new RestNotFoundError()
}
async function assertDecisionReferences(prisma: Prisma, workspaceId: string, body: Record<string, unknown>) {
  await assertDecisionReference(prisma, workspaceId, String(body.subjectType), String(body.subjectId))
  for (const source of (body.sources ?? []) as Array<{ type: string; id: string }>) await assertDecisionReference(prisma, workspaceId, source.type, source.id)
}
async function validateOpportunityRefs(prisma: Prisma, workspaceId: string, body: Record<string, unknown>) {
  if (typeof body.squadId === "string" && !(await prisma.squad.findFirst({ where: { id: body.squadId, workspaceId }, select: { id: true } }))) throw new RestNotFoundError()
  if (typeof body.linkedKeyResultId === "string" && !(await prisma.keyResult.findFirst({ where: { id: body.linkedKeyResultId, objective: { workspaceId } }, select: { id: true } }))) throw new RestNotFoundError()
}
async function validateFeedbackRefs(prisma: Prisma, workspaceId: string, body: Record<string, unknown>) {
  if (typeof body.opportunityId === "string" && !(await prisma.opportunity.findFirst({ where: { id: body.opportunityId, workspaceId }, select: { id: true } }))) throw new RestNotFoundError()
}
async function validateTaskRefs(prisma: Prisma, workspaceId: string, body: Record<string, unknown>) {
  const checks: Promise<unknown>[] = []
  if (typeof body.squadId === "string") checks.push(prisma.squad.findFirst({ where: { id: body.squadId, workspaceId }, select: { id: true } }))
  if (typeof body.parentTaskId === "string") checks.push(prisma.task.findFirst({ where: { id: body.parentTaskId, workspaceId }, select: { id: true } }))
  if (typeof body.assigneeUserId === "string") checks.push(prisma.workspaceMember.findFirst({ where: { userId: body.assigneeUserId, workspaceId }, select: { id: true } }))
  if ((await Promise.all(checks)).some((value) => !value)) throw new RestNotFoundError()
}
async function validateRoadmapRefs(prisma: Prisma, workspaceId: string, body: Record<string, unknown>) {
  const lookups: Promise<unknown>[] = []
  if (typeof body.squadId === "string") lookups.push(prisma.squad.findFirst({ where: { id: body.squadId, workspaceId }, select: { id: true } }))
  if (typeof body.solutionId === "string") lookups.push(prisma.solution.findFirst({ where: { id: body.solutionId, workspaceId }, select: { id: true } }))
  if (typeof body.opportunityId === "string") lookups.push(prisma.opportunity.findFirst({ where: { id: body.opportunityId, workspaceId }, select: { id: true } }))
  if (typeof body.keyResultId === "string") lookups.push(prisma.keyResult.findFirst({ where: { id: body.keyResultId, objective: { workspaceId } }, select: { id: true } }))
  if (typeof body.experimentId === "string") lookups.push(prisma.experiment.findFirst({ where: { id: body.experimentId, workspaceId }, select: { id: true } }))
  if (typeof body.feedbackId === "string") lookups.push(prisma.feedbackItem.findFirst({ where: { id: body.feedbackId, workspaceId }, select: { id: true } }))
  if ((await Promise.all(lookups)).some((value) => !value)) throw new RestNotFoundError()
}

async function requireObjective(prisma: Prisma, workspaceId: string, objectiveId: string) {
  if (!(await prisma.objective.findFirst({ where: { id: objectiveId, workspaceId }, select: { id: true } }))) throw new RestNotFoundError()
}
async function requireKeyResult(prisma: Prisma, workspaceId: string, keyResultId: string) {
  if (!(await prisma.keyResult.findFirst({ where: { id: keyResultId, objective: { workspaceId } }, select: { id: true } }))) throw new RestNotFoundError()
}
async function requireExperiment(prisma: Prisma, workspaceId: string, experimentId: string) {
  if (!(await prisma.experiment.findFirst({ where: { id: experimentId, workspaceId }, select: { id: true } }))) throw new RestNotFoundError()
}
async function validateObjectiveRefs(prisma: Prisma, workspaceId: string, body: Record<string, unknown>) {
  if (typeof body.cycleId === "string" && !(await prisma.oKRCycle.findFirst({ where: { id: body.cycleId, workspaceId }, select: { id: true } }))) throw new RestNotFoundError()
  if (typeof body.squadId === "string" && !(await prisma.squad.findFirst({ where: { id: body.squadId, workspaceId }, select: { id: true } }))) throw new RestNotFoundError()
  if (typeof body.parentKeyResultId === "string") {
    const eligible = await getEligibleParentKeyResults(workspaceId, typeof body.cycleId === "string" ? body.cycleId : null)
    if (!eligible.some((candidate) => candidate.id === body.parentKeyResultId)) throw new RestNotFoundError()
  }
}
async function validateExperimentRefs(prisma: Prisma, workspaceId: string, body: Record<string, unknown>) {
  if (typeof body.squadId === "string" && !(await prisma.squad.findFirst({ where: { id: body.squadId, workspaceId }, select: { id: true } }))) throw new RestNotFoundError()
  if (typeof body.assumptionId === "string" && !(await prisma.assumption.findFirst({ where: { id: body.assumptionId, solution: { workspaceId } }, select: { id: true } }))) throw new RestNotFoundError()
}
async function assertCustomObjectWorkspace(prisma: Prisma, workspaceId: string, objectType: string, objectId: string) {
  const found = objectType === "OPPORTUNITY" ? await prisma.opportunity.findFirst({ where: { id: objectId, workspaceId }, select: { id: true } })
    : objectType === "SOLUTION" ? await prisma.solution.findFirst({ where: { id: objectId, workspaceId }, select: { id: true } })
      : objectType === "EXPERIMENT" ? await prisma.experiment.findFirst({ where: { id: objectId, workspaceId }, select: { id: true } })
        : objectType === "OBJECTIVE" ? await prisma.objective.findFirst({ where: { id: objectId, workspaceId }, select: { id: true } })
          : objectType === "KEY_RESULT" ? await prisma.keyResult.findFirst({ where: { id: objectId, objective: { workspaceId } }, select: { id: true } })
            : objectType === "ROADMAP_ITEM" ? await prisma.roadmapItem.findFirst({ where: { id: objectId, workspaceId }, select: { id: true } })
              : objectType === "TASK" ? await prisma.task.findFirst({ where: { id: objectId, workspaceId }, select: { id: true } })
                : null
  if (!found) throw new RestNotFoundError()
}
async function assertCustomField(prisma: Prisma, workspaceId: string, objectType: string, fieldId: string) {
  if (!(await prisma.customFieldDefinition.findFirst({ where: { id: fieldId, workspaceId, objectType }, select: { id: true } }))) throw new RestNotFoundError()
}
async function workspaceOrganization(prisma: Prisma, workspaceId: string) {
  const workspace = await prisma.workspace.findFirst({ where: { id: workspaceId }, select: { organization: { select: { id: true, slug: true } } } })
  if (!workspace) throw new RestNotFoundError()
  return workspace.organization
}
