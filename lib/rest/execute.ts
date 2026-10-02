import getPrisma from "@/lib/db"
import { agentWorkspaceWhere } from "@/lib/agent-access"
import { assertOrgAdminBySlug, assertScoringModelAccess, assertWorkspaceMember, getMcpActor, isServiceActor } from "@/lib/mcp-authz"
import { decodeCursor, encodeCursor } from "@/lib/rest/cursor"
import type { RestAuthorizationPolicy, RestRoute } from "@/lib/rest/registry"
import { createOpportunity, updateOpportunity, updateOpportunityKeyResult, updateOpportunityStatus } from "@/lib/opportunity-tool-handlers"
import { createSolution, updateSolution } from "@/lib/solution-tool-handlers"
import { updateSolutionStatus } from "@/lib/solution-status-tool-handlers"
import { createAssumption, deleteAssumption, updateAssumption } from "@/lib/assumption-tool-handlers"
import { createFeedback, linkFeedbackToOpportunity, prepareFeedbackAttachmentUploadTool, updateFeedback, updateFeedbackStatus, updateFeedbackType } from "@/lib/feedback-tool-handlers"
import { createTask, moveTaskStatus, updateTask } from "@/lib/task-tool-handlers"
import { linkTask, unlinkTask } from "@/lib/task-tool-handlers"
import { createRoadmapItem, updateRoadmapItem } from "@/lib/roadmap-tool-handlers"
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
import { getCustomFieldValues, listCustomFieldDefinitions, setCustomFieldValue } from "@/lib/custom-field-tool-handlers"
import { listLinksTool } from "@/lib/typed-link-tool-handlers"
import { getEligibleParentKeyResults } from "@/lib/okr-hierarchy"
import { archiveScoringModel, createScoringModel, getOpportunityScore, getSolutionScore, listScoringModels, scoreOpportunity, scoreSolution, updateScoringModel } from "@/lib/scoring-tool-handlers"
import { captureWorkspaceMutation } from "@/lib/workspace-update-mutations"

export class RestNotFoundError extends Error {}
export class RestConflictError extends Error {}
export class RestCursorError extends Error {}

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
      const conclusion = String(body.conclusion), reason = nullable(body.reason)?.trim() ?? ""
      if (conclusion === "NOT_PURSUED" && !reason) throw new RestConflictError("NOT_PURSUED requires a reason.")
      const experiment = await prisma.experiment.findFirst({ where: { id, workspaceId }, select: { id: true, status: true, assumptionId: true } })
      if (!experiment) throw new RestNotFoundError()
      if (experiment.assumptionId && !(await prisma.assumption.findFirst({ where: { id: experiment.assumptionId, solution: { workspaceId } }, select: { id: true } }))) throw new RestNotFoundError()
      if (["COMPLETE", "KILLED", "NOT_PURSUED"].includes(experiment.status)) throw new RestConflictError("The experiment is already concluded.")
      const status = conclusion === "KILL" ? "KILLED" : conclusion === "NOT_PURSUED" ? "NOT_PURSUED" : "COMPLETE"
      const updated = await captureWorkspaceMutation(prisma, "experiment", "update", mutationActor, id, tx => tx.experiment.update({ where: { id }, data: { status, conclusion, conclusionReason: reason || null, endDate: new Date(), updatedAt: new Date(), source: "API" }, select: select.experiment }))
      if (experiment.assumptionId) await captureWorkspaceMutation(prisma, "assumption", "update", mutationActor, experiment.assumptionId, tx => tx.assumption.update({ where: { id: experiment.assumptionId! }, data: { status: conclusion === "PROCEED" ? "VALIDATED" : conclusion === "KILL" ? "INVALIDATED" : "UNTESTED", updatedAt: new Date(), source: "API" } }))
      return serialize(updated)
    }

    case "listMetrics": return analyticsData(await handleAnalyticsTool("list_metrics", { workspaceId }))
    case "getMetric": return analyticsData(await handleAnalyticsTool("get_metric", { workspaceId, metricId: id }))
    case "createMetric": return analyticsData(await handleAnalyticsTool("create_metric", { workspaceId, ...body }))
    case "updateMetric": return analyticsData(await handleAnalyticsTool("update_metric", { workspaceId, metricId: id, ...body }))
    case "archiveMetric": { await analyticsData(await handleAnalyticsTool("archive_metric", { workspaceId, metricId: id })); return undefined }
    case "listMetricBindings": return analyticsData(await handleAnalyticsTool("list_metric_bindings", { workspaceId, ...input.query }))
    case "getMetricBinding": return analyticsData(await handleAnalyticsTool("get_metric_binding", { workspaceId, bindingId: id }))
    case "createMetricBinding": return analyticsData(await handleAnalyticsTool("link_metric", { workspaceId, ...body }))
    case "updateMetricBinding": return analyticsData(await handleAnalyticsTool("update_metric_binding", { workspaceId, bindingId: id, ...body }))
    case "deleteMetricBinding": { await analyticsData(await handleAnalyticsTool("unlink_metric", { workspaceId, bindingId: id })); return undefined }
    case "refreshMetricBinding": return analyticsData(await handleAnalyticsTool("refresh_metric_binding", { workspaceId, bindingId: id, requestId: body.requestId }))
    case "listMetricObservations": return analyticsData(await handleAnalyticsTool("list_metric_observations", { workspaceId, bindingId: id }))
    case "getMetricObservation": return analyticsData(await handleAnalyticsTool("get_metric_observation", { workspaceId, observationId: id }))

    case "listScoringModels": { const org = await workspaceOrganization(prisma, workspaceId); const data = ensureTool(await listScoringModels({ orgSlug: org.slug })) as { items: Array<{ id: string }> }; return Promise.all(data.items.map((item) => prisma.scoringModel.findFirst({ where: { id: item.id, organizationId: org.id }, select: select.scoringModel }))).then((items) => items.filter(Boolean).map(serialize)) }
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
    case "listCustomFieldDefinitions": return toolItems(await listCustomFieldDefinitions({ workspaceId, objectType: input.query.objectType as never }))
    case "listCustomFieldValues": { await assertCustomObjectWorkspace(prisma, workspaceId, input.params.objectType, input.params.objectId); return toolItems(await getCustomFieldValues({ objectType: input.params.objectType as never, objectId: input.params.objectId })) }
    case "setCustomFieldValue": { await assertCustomObjectWorkspace(prisma, workspaceId, input.params.objectType, input.params.objectId); ensureTool(await setCustomFieldValue({ objectType: input.params.objectType as never, objectId: input.params.objectId, fieldId: String(body.fieldId), value: body.value as never })); const values = toolItems(await getCustomFieldValues({ objectType: input.params.objectType as never, objectId: input.params.objectId })); return found(values.find((value) => value.id === body.fieldId)) }
    case "listEntityLinks": return normalizeLinks(ensureTool(await listLinksTool({ workspaceId, ...(input.query as { opportunityId?: string; objectiveId?: string; solutionId?: string; keyResultId?: string; limit?: number; cursor?: string }) })) as Record<string, unknown>)
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
    default:
      throw new RestNotFoundError()
  }
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

function cursorWhere(cursor: { id: string; createdAt: string } | null): Record<string, unknown> {
  if (!cursor) return {}
  const createdAt = new Date(cursor.createdAt)
  return { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: cursor.id } }] }
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
  if (!result.structuredContent.ok) throw new RestConflictError(result.structuredContent.message)
  const data = result.structuredContent.data
  return data
}

function toolItems(result: ToolResult): Array<Record<string, unknown>> {
  const data = ensureTool(result) as { items?: Array<Record<string, unknown>> }
  return data.items ?? []
}

function analyticsData(result: ToolResult): unknown {
  const data = ensureTool(result)
  if (data && typeof data === "object" && "items" in data) return (data as { items: unknown[] }).items
  return data
}

function normalizeLinks(data: Record<string, unknown>) {
  return { items: Array.isArray(data.items) ? data.items.map(serialize) : [], nextCursor: typeof data.nextCursor === "string" ? data.nextCursor : null }
}

type Prisma = ReturnType<typeof getPrisma>
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
async function workspaceOrganization(prisma: Prisma, workspaceId: string) {
  const workspace = await prisma.workspace.findFirst({ where: { id: workspaceId }, select: { organization: { select: { id: true, slug: true } } } })
  if (!workspace) throw new RestNotFoundError()
  return workspace.organization
}
