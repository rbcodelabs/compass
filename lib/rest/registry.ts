import { z } from "zod"
import {
  assumptionSchema, collectionOf, cursorQuery, feedbackSchema, identitySchema,
  opportunityObjectiveRelationshipSchema, opportunitySchema, roadmapItemSchema, solutionKeyResultRelationshipSchema,
  solutionSchema, taskSchema, uploadPreparationSchema, uuid, workspaceSchema,
} from "@/lib/rest/schemas"
import { FEEDBACK_ATTACHMENT_ALLOWED_MIME_TYPES, FEEDBACK_ATTACHMENT_MAX_FILE_BYTES } from "@/lib/feedback-attachment-rules"
import { FEEDBACK_STATUSES } from "@/lib/feedback-meta"

export type ApiScope = "api:read" | "api:write"
export type RestMethod = "GET" | "POST" | "PATCH" | "DELETE"
export type RestAuthorizationPolicy = "authenticated-actor" | "accessible-workspaces" | "workspace-member" | "workspace-writer"

export type RestRoute = {
  method: RestMethod
  path: string
  operationId: string
  summary: string
  scope: ApiScope
  authorizationPolicy: RestAuthorizationPolicy
  pathSchema: z.ZodType
  querySchema?: z.ZodType
  bodySchema?: z.ZodType
  responseSchema: z.ZodType
  status?: number
}

const workspacePath = z.object({ workspaceId: uuid })
const itemPath = z.object({ workspaceId: uuid, id: uuid })
const relatedItemPath = z.object({ workspaceId: uuid, id: uuid, relatedId: uuid })
const taskLinkPath = z.object({
  workspaceId: uuid,
  id: uuid,
  linkedType: z.enum(["OPPORTUNITY", "SOLUTION", "ROADMAP_ITEM", "OBJECTIVE", "KEY_RESULT", "DOC", "EXPERIMENT", "FEEDBACK_ITEM", "DECISION"]),
  relatedId: uuid,
})
const read = (operationId: string, path: string, summary: string, responseSchema: z.ZodType, pathSchema: z.ZodType = z.object({}), querySchema?: z.ZodType, authorizationPolicy: RestAuthorizationPolicy = "workspace-member"): RestRoute => ({
  method: "GET", path, operationId, summary, scope: "api:read", authorizationPolicy, pathSchema, querySchema, responseSchema,
})
const write = (method: "POST" | "PATCH" | "DELETE", operationId: string, path: string, summary: string, responseSchema: z.ZodType, pathSchema: z.ZodType, bodySchema?: z.ZodType, status?: number): RestRoute => ({
  method, path, operationId, summary, scope: "api:write", authorizationPolicy: "workspace-writer", pathSchema, bodySchema, responseSchema, status,
})
const oneMutationGroup = (groups: readonly (readonly string[])[]) => (value: Record<string, unknown>, ctx: z.RefinementCtx) => {
  const populated = groups.filter((group) => group.some((key) => value[key] !== undefined))
  if (populated.length > 1) ctx.addIssue({ code: "custom", message: "Fields from separate lifecycle operations must be sent in separate PATCH requests." })
}

const opportunityCreate = z.object({ title: z.string().trim().min(1).max(255), description: z.string().trim().nullable().optional(), customerSegment: z.string().trim().max(255).nullable().optional(), status: opportunitySchema.shape.status.exclude(["ARCHIVED"]).optional(), squadId: uuid.nullable().optional(), linkedKeyResultId: uuid.nullable().optional() }).strict()
const opportunityPatch = opportunityCreate.omit({ squadId: true }).partial().refine((value) => Object.keys(value).length > 0, "Provide at least one field.").superRefine(oneMutationGroup([["title", "description", "customerSegment"], ["status"], ["linkedKeyResultId"]]))
const solutionCreate = z.object({ opportunityId: uuid, title: z.string().trim().min(1).max(255), description: z.string().trim().nullable().optional() }).strict()
const solutionPatch = z.object({ title: z.string().trim().min(1).max(255).optional(), description: z.string().trim().nullable().optional(), status: solutionSchema.shape.status.optional() }).strict().refine((value) => Object.keys(value).length > 0, "Provide at least one field.").superRefine(oneMutationGroup([["title", "description"], ["status"]]))
const assumptionCreate = z.object({ solutionId: uuid, title: z.string().trim().min(1).max(255), description: z.string().trim().nullable().optional(), riskLevel: assumptionSchema.shape.riskLevel.optional() }).strict()
const assumptionPatch = z.object({ title: z.string().trim().min(1).max(255).optional(), description: z.string().trim().nullable().optional(), riskLevel: assumptionSchema.shape.riskLevel.optional(), status: assumptionSchema.shape.status.optional() }).strict().refine((value) => Object.keys(value).length > 0, "Provide at least one field.")
const feedbackCreate = z.object({ title: z.string().trim().min(1).max(255), description: z.string().trim().nullable().optional(), type: z.enum(["BUG", "IDEA"]).optional(), submitterName: z.string().trim().max(255).nullable().optional(), submitterEmail: z.string().email().nullable().optional() }).strict()
const feedbackPatch = z.object({ title: z.string().trim().min(1).max(255).optional(), description: z.string().trim().nullable().optional(), type: z.enum(["BUG", "IDEA"]).optional(), status: z.enum([...FEEDBACK_STATUSES, "CLOSED"]).optional(), opportunityId: uuid.optional() }).strict().refine((value) => Object.keys(value).length > 0, "Provide at least one field.").superRefine(oneMutationGroup([["title", "description"], ["type"], ["status"], ["opportunityId"]]))
const taskCreate = z.object({ title: z.string().trim().min(1).max(255), description: z.string().trim().nullable().optional(), status: z.enum(["BACKLOG", "TODO", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "DONE", "CANCELLED"]).optional(), priority: z.enum(["URGENT", "HIGH", "MEDIUM", "LOW"]).optional(), squadId: uuid.nullable().optional(), parentTaskId: uuid.nullable().optional(), assigneeUserId: uuid.nullable().optional(), ownerName: z.string().trim().max(255).nullable().optional(), storyPoints: z.number().nonnegative().nullable().optional(), dueDate: z.string().datetime().nullable().optional(), iteration: z.string().trim().max(100).nullable().optional() }).strict()
const taskPatch = taskCreate.omit({ parentTaskId: true }).partial().refine((value) => Object.keys(value).length > 0, "Provide at least one field.").superRefine(oneMutationGroup([["title", "description", "priority", "squadId", "assigneeUserId", "ownerName", "storyPoints", "dueDate", "iteration"], ["status"]]))
const roadmapPatch = z.object({ title: z.string().trim().min(1).max(255).optional(), description: z.string().trim().nullable().optional(), horizon: z.enum(["LATER", "NEXT", "NOW", "LAUNCHING", "LAUNCHED", "SHIPPED"]).optional(), status: z.enum(["ACTIVE", "ARCHIVED"]).optional(), isPrivate: z.boolean().optional(), startDate: z.string().datetime().nullable().optional(), endDate: z.string().datetime().nullable().optional(), solutionId: uuid.nullable().optional(), keyResultId: uuid.nullable().optional(), opportunityId: uuid.nullable().optional(), squadId: uuid.nullable().optional() }).strict().refine((value) => Object.keys(value).length > 0, "Provide at least one field.")
const taskLinkCreate = z.object({ linkedType: taskLinkPath.shape.linkedType, linkedId: uuid }).strict()
const uploadPreparationCreate = z.object({
  filename: z.string().trim().min(1).max(255),
  fileType: z.enum(FEEDBACK_ATTACHMENT_ALLOWED_MIME_TYPES),
  fileSize: z.number().int().min(1).max(FEEDBACK_ATTACHMENT_MAX_FILE_BYTES),
}).strict()
const taskLinkResult = z.object({ taskId: uuid, linkedType: taskLinkPath.shape.linkedType, linkedId: uuid })
const opportunityQuery = cursorQuery.extend({ status: opportunitySchema.shape.status.optional(), squadId: uuid.optional() }).strict()
const solutionQuery = cursorQuery.extend({ status: solutionSchema.shape.status.optional(), opportunityId: uuid.optional() }).strict()
const assumptionQuery = cursorQuery.extend({ status: assumptionSchema.shape.status.optional(), riskLevel: assumptionSchema.shape.riskLevel.optional(), solutionId: uuid.optional() }).strict()
const feedbackQuery = cursorQuery.extend({ status: z.enum([...FEEDBACK_STATUSES, "CLOSED"]).optional(), type: z.enum(["BUG", "IDEA"]).optional(), opportunityId: uuid.optional() }).strict()
const taskQuery = cursorQuery.extend({ status: taskCreate.shape.status, priority: taskCreate.shape.priority, squadId: uuid.optional(), parentTaskId: uuid.optional() }).strict()
const roadmapQuery = cursorQuery.extend({ horizon: roadmapItemSchema.shape.horizon.optional(), status: z.string().max(50).optional(), squadId: uuid.optional() }).strict()

export const REST_ROUTES: readonly RestRoute[] = [
  read("getCurrentIdentity", "/api/v1/me", "Get the current programmatic identity", identitySchema, z.object({}), undefined, "authenticated-actor"),
  read("listWorkspaces", "/api/v1/workspaces", "List accessible workspaces", collectionOf(workspaceSchema), z.object({}), cursorQuery.strict(), "accessible-workspaces"),
  read("getWorkspace", "/api/v1/workspaces/{workspaceId}", "Get a workspace", workspaceSchema, workspacePath),
  read("listOpportunities", "/api/v1/workspaces/{workspaceId}/opportunities", "List opportunities", collectionOf(opportunitySchema), workspacePath, opportunityQuery),
  write("POST", "createOpportunity", "/api/v1/workspaces/{workspaceId}/opportunities", "Create an opportunity", opportunitySchema, workspacePath, opportunityCreate, 201),
  read("getOpportunity", "/api/v1/workspaces/{workspaceId}/opportunities/{id}", "Get an opportunity", opportunitySchema, itemPath),
  write("PATCH", "updateOpportunity", "/api/v1/workspaces/{workspaceId}/opportunities/{id}", "Update an opportunity", opportunitySchema, itemPath, opportunityPatch),
  write("POST", "linkOpportunityObjective", "/api/v1/workspaces/{workspaceId}/opportunities/{id}/objective-links", "Link an opportunity to an objective", opportunityObjectiveRelationshipSchema, itemPath, z.object({ objectiveId: uuid }).strict(), 201),
  write("DELETE", "unlinkOpportunityObjective", "/api/v1/workspaces/{workspaceId}/opportunities/{id}/objective-links/{relatedId}", "Unlink an opportunity from an objective", z.undefined(), relatedItemPath, undefined, 204),
  read("listSolutions", "/api/v1/workspaces/{workspaceId}/solutions", "List solutions", collectionOf(solutionSchema), workspacePath, solutionQuery),
  write("POST", "createSolution", "/api/v1/workspaces/{workspaceId}/solutions", "Create a solution", solutionSchema, workspacePath, solutionCreate, 201),
  read("getSolution", "/api/v1/workspaces/{workspaceId}/solutions/{id}", "Get a solution", solutionSchema, itemPath),
  write("PATCH", "updateSolution", "/api/v1/workspaces/{workspaceId}/solutions/{id}", "Update a solution", solutionSchema, itemPath, solutionPatch),
  write("POST", "linkSolutionKeyResult", "/api/v1/workspaces/{workspaceId}/solutions/{id}/key-result-links", "Link a solution to a key result", solutionKeyResultRelationshipSchema, itemPath, z.object({ keyResultId: uuid }).strict(), 201),
  write("DELETE", "unlinkSolutionKeyResult", "/api/v1/workspaces/{workspaceId}/solutions/{id}/key-result-links/{relatedId}", "Unlink a solution from a key result", z.undefined(), relatedItemPath, undefined, 204),
  read("listAssumptions", "/api/v1/workspaces/{workspaceId}/assumptions", "List assumptions", collectionOf(assumptionSchema), workspacePath, assumptionQuery),
  write("POST", "createAssumption", "/api/v1/workspaces/{workspaceId}/assumptions", "Create an assumption", assumptionSchema, workspacePath, assumptionCreate, 201),
  read("getAssumption", "/api/v1/workspaces/{workspaceId}/assumptions/{id}", "Get an assumption", assumptionSchema, itemPath),
  write("PATCH", "updateAssumption", "/api/v1/workspaces/{workspaceId}/assumptions/{id}", "Update an assumption", assumptionSchema, itemPath, assumptionPatch),
  write("DELETE", "deleteAssumption", "/api/v1/workspaces/{workspaceId}/assumptions/{id}", "Delete an assumption", z.undefined(), itemPath, undefined, 204),
  read("listFeedback", "/api/v1/workspaces/{workspaceId}/feedback", "List feedback", collectionOf(feedbackSchema), workspacePath, feedbackQuery),
  write("POST", "createFeedback", "/api/v1/workspaces/{workspaceId}/feedback", "Create feedback", feedbackSchema, workspacePath, feedbackCreate, 201),
  read("getFeedback", "/api/v1/workspaces/{workspaceId}/feedback/{id}", "Get feedback", feedbackSchema, itemPath),
  write("PATCH", "updateFeedback", "/api/v1/workspaces/{workspaceId}/feedback/{id}", "Update feedback", feedbackSchema, itemPath, feedbackPatch),
  write("POST", "prepareFeedbackAttachmentUpload", "/api/v1/workspaces/{workspaceId}/feedback-attachment-uploads", "Prepare a direct feedback attachment upload", uploadPreparationSchema, workspacePath, uploadPreparationCreate, 201),
  read("listTasks", "/api/v1/workspaces/{workspaceId}/tasks", "List tasks", collectionOf(taskSchema), workspacePath, taskQuery),
  write("POST", "createTask", "/api/v1/workspaces/{workspaceId}/tasks", "Create a task", taskSchema, workspacePath, taskCreate, 201),
  read("getTask", "/api/v1/workspaces/{workspaceId}/tasks/{id}", "Get a task", taskSchema, itemPath),
  write("PATCH", "updateTask", "/api/v1/workspaces/{workspaceId}/tasks/{id}", "Update a task", taskSchema, itemPath, taskPatch),
  write("POST", "linkTaskResource", "/api/v1/workspaces/{workspaceId}/tasks/{id}/links", "Link a task to another resource", taskLinkResult, itemPath, taskLinkCreate, 201),
  write("DELETE", "unlinkTaskResource", "/api/v1/workspaces/{workspaceId}/tasks/{id}/links/{linkedType}/{relatedId}", "Unlink a task from another resource", z.undefined(), taskLinkPath, undefined, 204),
  read("listRoadmapItems", "/api/v1/workspaces/{workspaceId}/roadmap-items", "List roadmap items", collectionOf(roadmapItemSchema), workspacePath, roadmapQuery),
  read("getRoadmapItem", "/api/v1/workspaces/{workspaceId}/roadmap-items/{id}", "Get a roadmap item", roadmapItemSchema, itemPath),
  write("PATCH", "updateRoadmapItem", "/api/v1/workspaces/{workspaceId}/roadmap-items/{id}", "Update a roadmap item", roadmapItemSchema, itemPath, roadmapPatch),
] as const

function routePattern(path: string): { regexp: RegExp; names: string[] } {
  const names: string[] = []
  const source = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{([^}]+)\\\}/g, (_, name: string) => {
    names.push(name)
    return "([^/]+)"
  })
  return { regexp: new RegExp(`^${source}$`), names }
}

export function matchRestRoute(method: string, pathname: string): { route: RestRoute; params: Record<string, string> } | null {
  for (const route of REST_ROUTES) {
    if (route.method !== method) continue
    const { regexp, names } = routePattern(route.path)
    const match = regexp.exec(pathname)
    if (!match) continue
    return { route, params: Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1])])) }
  }
  return null
}
