import getPrisma from "@/lib/db"
import { agentWorkspaceWhere } from "@/lib/agent-access"
import { assertWorkspaceMember, getMcpActor, isServiceActor } from "@/lib/mcp-authz"
import { decodeCursor, encodeCursor } from "@/lib/rest/cursor"
import type { RestAuthorizationPolicy, RestRoute } from "@/lib/rest/registry"
import { createOpportunity, updateOpportunity, updateOpportunityKeyResult, updateOpportunityStatus } from "@/lib/opportunity-tool-handlers"
import { createSolution, updateSolution } from "@/lib/solution-tool-handlers"
import { updateSolutionStatus } from "@/lib/solution-status-tool-handlers"
import { createAssumption, deleteAssumption, updateAssumption } from "@/lib/assumption-tool-handlers"
import { createFeedback, linkFeedbackToOpportunity, prepareFeedbackAttachmentUploadTool, updateFeedback, updateFeedbackStatus, updateFeedbackType } from "@/lib/feedback-tool-handlers"
import { createTask, moveTaskStatus, updateTask } from "@/lib/task-tool-handlers"
import { linkTask, unlinkTask } from "@/lib/task-tool-handlers"
import { updateRoadmapItem } from "@/lib/roadmap-tool-handlers"
import {
  linkOpportunityToObjectiveTool,
  linkSolutionToKeyResultTool,
  unlinkOpportunityFromObjectiveTool,
  unlinkSolutionFromKeyResultTool,
} from "@/lib/typed-link-tool-handlers"
import type { ToolResult } from "@/lib/mcp-output"

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
} as const

export async function executeRestRoute(route: RestRoute, input: Input): Promise<unknown> {
  const prisma = getPrisma()
  const actor = getMcpActor()
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
    case "getRoadmapItem": return serialize(found(await prisma.roadmapItem.findFirst({ where: { id, workspaceId }, select: select.roadmap })))
    case "updateRoadmapItem": {
      if (body.horizon === "LAUNCHING" || body.horizon === "LAUNCHED") throw new RestConflictError("Use the launch workflow resource for this transition.")
      await validateRoadmapRefs(prisma, workspaceId, body)
      const existing = await prisma.roadmapItem.findFirst({ where: { id, workspaceId }, select: { id: true } }); if (!existing) throw new RestNotFoundError()
      ensureTool(await updateRoadmapItem({ itemId: id, ...(body as Omit<Parameters<typeof updateRoadmapItem>[0], "itemId">), source: "API" }))
      return serialize(found(await prisma.roadmapItem.findFirst({ where: { id, workspaceId }, select: select.roadmap })))
    }
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
function serialize(value: unknown): unknown { return JSON.parse(JSON.stringify(value)) }

function ensureTool(result: ToolResult): unknown {
  if (!result.structuredContent.ok) throw new RestConflictError(result.structuredContent.message)
  const data = result.structuredContent.data
  return data
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
