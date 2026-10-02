import { z } from "zod"
import {
  assumptionSchema, checkInSchema, collectionOf, cursorQuery, customFieldDefinitionSchema, customFieldValueSchema,
  experimentResultSchema, experimentSchema, feedbackSchema, identitySchema, keyResultSchema, metricBindingSchema, metricObservationSchema, metricSchema,
  objectiveSchema, okrCycleSchema, scoreSchema, scoringMetricSchema, scoringModelSchema, squadSchema, typedLinkSchema,
  opportunityObjectiveRelationshipSchema, opportunitySchema, roadmapItemSchema, solutionKeyResultRelationshipSchema,
  solutionSchema, taskSchema, uploadPreparationSchema, uuid, workspaceSchema,
} from "@/lib/rest/schemas"
import { FEEDBACK_ATTACHMENT_ALLOWED_MIME_TYPES, FEEDBACK_ATTACHMENT_MAX_FILE_BYTES } from "@/lib/feedback-attachment-rules"
import { FEEDBACK_STATUSES } from "@/lib/feedback-meta"
import { linkMetricSchema, metricInputSchema, targetSchema, updateMetricBindingSchema } from "@/lib/analytics/service"

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
const opportunityCreate = z.object({ title: z.string().trim().min(1).max(255), description: z.string().trim().nullable().optional(), customerSegment: z.string().trim().max(255).nullable().optional(), status: opportunitySchema.shape.status.exclude(["ARCHIVED"]).optional(), squadId: uuid.nullable().optional(), linkedKeyResultId: uuid.nullable().optional() }).strict()
const opportunityPatch = z.union([
  z.object({ title: opportunityCreate.shape.title.optional(), description: opportunityCreate.shape.description, customerSegment: opportunityCreate.shape.customerSegment }).strict(),
  z.object({ status: opportunitySchema.shape.status }).strict(),
  z.object({ linkedKeyResultId: uuid.nullable() }).strict(),
])
const solutionCreate = z.object({ opportunityId: uuid, title: z.string().trim().min(1).max(255), description: z.string().trim().nullable().optional() }).strict()
const solutionPatch = z.union([
  z.object({ title: z.string().trim().min(1).max(255).optional(), description: z.string().trim().nullable().optional() }).strict(),
  z.object({ status: solutionSchema.shape.status }).strict(),
])
const assumptionCreate = z.object({ solutionId: uuid, title: z.string().trim().min(1).max(255), description: z.string().trim().nullable().optional(), riskLevel: assumptionSchema.shape.riskLevel.optional() }).strict()
const assumptionPatch = z.object({ title: z.string().trim().min(1).max(255).optional(), description: z.string().trim().nullable().optional(), riskLevel: assumptionSchema.shape.riskLevel.optional(), status: assumptionSchema.shape.status.optional() }).strict()
const feedbackCreate = z.object({ title: z.string().trim().min(1).max(255), description: z.string().trim().nullable().optional(), type: z.enum(["BUG", "IDEA"]).optional(), submitterName: z.string().trim().max(255).nullable().optional(), submitterEmail: z.string().email().nullable().optional() }).strict()
const feedbackPatch = z.union([
  z.object({ title: z.string().trim().min(1).max(255).optional(), description: z.string().trim().nullable().optional() }).strict(),
  z.object({ type: z.enum(["BUG", "IDEA"]) }).strict(),
  z.object({ status: z.enum([...FEEDBACK_STATUSES, "CLOSED"]) }).strict(),
  z.object({ opportunityId: uuid }).strict(),
])
const taskCreate = z.object({ title: z.string().trim().min(1).max(255), description: z.string().trim().nullable().optional(), status: z.enum(["BACKLOG", "TODO", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "DONE", "CANCELLED"]).optional(), priority: z.enum(["URGENT", "HIGH", "MEDIUM", "LOW"]).optional(), squadId: uuid.nullable().optional(), parentTaskId: uuid.nullable().optional(), assigneeUserId: uuid.nullable().optional(), ownerName: z.string().trim().max(255).nullable().optional(), storyPoints: z.number().nonnegative().nullable().optional(), dueDate: z.string().datetime().nullable().optional(), iteration: z.string().trim().max(100).nullable().optional() }).strict()
const taskPatch = z.union([
  taskCreate.omit({ parentTaskId: true, status: true }).partial().strict(),
  z.object({ status: taskCreate.shape.status.unwrap() }).strict(),
])
const roadmapCreate = z.object({
  title: z.string().trim().min(1).max(255),
  horizon: z.enum(["NOW", "NEXT", "LATER", "SHIPPED"]),
  description: z.string().trim().nullable().optional(),
  solutionId: uuid.nullable().optional(), keyResultId: uuid.nullable().optional(), opportunityId: uuid.nullable().optional(), squadId: uuid.nullable().optional(),
  startDate: z.string().date().nullable().optional(), endDate: z.string().date().nullable().optional(), isPrivate: z.boolean().optional(),
}).strict()
const roadmapPatch = z.object({ title: z.string().trim().min(1).max(255).optional(), description: z.string().trim().nullable().optional(), horizon: z.enum(["LATER", "NEXT", "NOW", "LAUNCHING", "LAUNCHED", "SHIPPED"]).optional(), status: z.enum(["ACTIVE", "ARCHIVED"]).optional(), isPrivate: z.boolean().optional(), startDate: z.string().datetime().nullable().optional(), endDate: z.string().datetime().nullable().optional(), solutionId: uuid.nullable().optional(), keyResultId: uuid.nullable().optional(), opportunityId: uuid.nullable().optional(), squadId: uuid.nullable().optional() }).strict()
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
const expectedUpdatedAt = z.string().datetime()
const cycleCreate = z.object({ title: z.string().trim().min(1).max(255), startDate: z.string().date(), endDate: z.string().date(), status: z.enum(["DRAFT", "ACTIVE", "COMPLETED"]).optional() }).strict()
const objectiveCreate = z.object({ cycleId: uuid.nullable().optional(), title: z.string().trim().min(1).max(255), description: z.string().trim().nullable().optional(), owner: z.string().trim().max(255).nullable().optional(), squadId: uuid.nullable().optional(), parentKeyResultId: uuid.nullable().optional() }).strict()
const objectivePatch = z.object({ title: z.string().trim().min(1).max(255).optional(), description: z.string().trim().nullable().optional(), status: objectiveSchema.shape.status.optional() }).strict()
const keyResultCreate = z.object({ title: z.string().trim().min(1).max(255), target: z.number().finite(), unit: z.string().trim().max(50).nullable().optional() }).strict()
const keyResultPatch = z.object({ title: z.string().trim().min(1).max(255).optional(), target: z.number().finite().optional(), current: z.number().finite().optional(), unit: z.string().trim().max(50).nullable().optional() }).strict()
const checkInCreate = z.object({ value: z.number().finite(), note: z.string().trim().nullable().optional() }).strict()
const experimentCreate = z.object({ title: z.string().trim().min(1).max(255), hypothesis: z.string().trim().min(1), method: z.string().trim().min(1), killCondition: z.string().trim().min(1), assumptionId: uuid.nullable().optional(), squadId: uuid.nullable().optional() }).strict()
const experimentPatch = z.object({ expectedUpdatedAt, title: z.string().trim().min(1).max(255).optional(), hypothesis: z.string().trim().min(1).optional(), method: z.string().trim().min(1).optional(), killCondition: z.string().trim().min(1).optional() }).strict()
const experimentResultCreate = z.object({ note: z.string().trim().min(1), metric: z.string().trim().max(255).nullable().optional(), value: z.number().finite().nullable().optional() }).strict()
const experimentConclusion = z.object({ expectedUpdatedAt, conclusion: z.enum(["PROCEED", "KILL", "ITERATE", "NOT_PURSUED"]), reason: z.string().trim().nullable().optional() }).strict()
const metricPatch = metricInputSchema.extend({ expectedRevision: z.number().int().positive() }).strict()
const scoringMetricInput = scoringMetricSchema.omit({ order: true })
const scoringModelCreate = z.object({ name: z.string().trim().min(1).max(255), description: z.string().trim().nullable().optional(), formulaType: z.enum(["WEIGHTED_SUM", "MULTIPLICATIVE"]), metrics: z.array(scoringMetricInput).min(1) }).strict()
const optionalScoringModelFields = { name: z.string().trim().min(1).max(255).optional(), description: z.string().trim().nullable().optional() }
const scoringModelPatch = z.union([
  z.object({ ...optionalScoringModelFields, metrics: z.array(scoringMetricInput).min(1).optional() }).strict(),
  z.object({ ...optionalScoringModelFields, formulaType: z.enum(["WEIGHTED_SUM", "MULTIPLICATIVE"]), metrics: z.array(scoringMetricInput).min(1) }).strict(),
])
const scoreCreate = z.object({ values: z.record(z.string(), z.number().finite()) }).strict()
const squadCreate = z.object({ name: z.string().trim().min(1).max(255), color: z.string().trim().max(50).optional() }).strict()
const customObjectType = z.enum(["OPPORTUNITY", "SOLUTION", "EXPERIMENT", "OBJECTIVE", "KEY_RESULT", "ROADMAP_ITEM", "TASK"])
const customValuePath = z.object({ workspaceId: uuid, objectType: customObjectType, objectId: uuid })
const customFieldValueCreate = z.object({ fieldId: uuid, value: z.unknown().nullable() }).strict()
const entityLinksQuery = cursorQuery.extend({ opportunityId: uuid.optional(), objectiveId: uuid.optional(), solutionId: uuid.optional(), keyResultId: uuid.optional() }).strict().refine((value) => [value.opportunityId, value.objectiveId, value.solutionId, value.keyResultId].filter(Boolean).length === 1, { message: "Provide exactly one entity id." })

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
  write("POST", "createRoadmapItem", "/api/v1/workspaces/{workspaceId}/roadmap-items", "Create a roadmap item", roadmapItemSchema, workspacePath, roadmapCreate, 201),
  read("getRoadmapItem", "/api/v1/workspaces/{workspaceId}/roadmap-items/{id}", "Get a roadmap item", roadmapItemSchema, itemPath),
  write("PATCH", "updateRoadmapItem", "/api/v1/workspaces/{workspaceId}/roadmap-items/{id}", "Update a roadmap item", roadmapItemSchema, itemPath, roadmapPatch),

  read("listOkrCycles", "/api/v1/workspaces/{workspaceId}/okr-cycles", "List OKR cycles", collectionOf(okrCycleSchema), workspacePath, cursorQuery.strict()),
  write("POST", "createOkrCycle", "/api/v1/workspaces/{workspaceId}/okr-cycles", "Create an OKR cycle", okrCycleSchema, workspacePath, cycleCreate, 201),
  read("getOkrCycle", "/api/v1/workspaces/{workspaceId}/okr-cycles/{id}", "Get an OKR cycle", okrCycleSchema, itemPath),
  read("listObjectives", "/api/v1/workspaces/{workspaceId}/objectives", "List objectives", collectionOf(objectiveSchema), workspacePath, cursorQuery.extend({ cycleId: uuid.nullable().optional(), status: objectiveSchema.shape.status.optional() }).strict()),
  write("POST", "createObjective", "/api/v1/workspaces/{workspaceId}/objectives", "Create an objective", objectiveSchema, workspacePath, objectiveCreate, 201),
  read("getObjective", "/api/v1/workspaces/{workspaceId}/objectives/{id}", "Get an objective", objectiveSchema, itemPath),
  write("PATCH", "updateObjective", "/api/v1/workspaces/{workspaceId}/objectives/{id}", "Update an objective", objectiveSchema, itemPath, objectivePatch),
  write("DELETE", "deleteObjective", "/api/v1/workspaces/{workspaceId}/objectives/{id}", "Delete a childless objective", z.undefined(), itemPath, undefined, 204),
  read("listKeyResults", "/api/v1/workspaces/{workspaceId}/objectives/{id}/key-results", "List objective key results", collectionOf(keyResultSchema), itemPath, cursorQuery.strict()),
  write("POST", "createKeyResult", "/api/v1/workspaces/{workspaceId}/objectives/{id}/key-results", "Create a key result", keyResultSchema, itemPath, keyResultCreate, 201),
  read("getKeyResult", "/api/v1/workspaces/{workspaceId}/key-results/{id}", "Get a key result", keyResultSchema, itemPath),
  write("PATCH", "updateKeyResult", "/api/v1/workspaces/{workspaceId}/key-results/{id}", "Update a key result", keyResultSchema, itemPath, keyResultPatch),
  write("DELETE", "deleteKeyResult", "/api/v1/workspaces/{workspaceId}/key-results/{id}", "Delete a key result atomically", z.undefined(), itemPath, undefined, 204),
  read("listCheckIns", "/api/v1/workspaces/{workspaceId}/key-results/{id}/check-ins", "List key-result check-ins", collectionOf(checkInSchema), itemPath, cursorQuery.strict()),
  write("POST", "createCheckIn", "/api/v1/workspaces/{workspaceId}/key-results/{id}/check-ins", "Record a key-result check-in", checkInSchema, itemPath, checkInCreate, 201),

  read("listExperiments", "/api/v1/workspaces/{workspaceId}/experiments", "List experiments", collectionOf(experimentSchema), workspacePath, cursorQuery.extend({ status: experimentSchema.shape.status.optional(), squadId: uuid.optional(), assumptionId: uuid.optional() }).strict()),
  write("POST", "createExperiment", "/api/v1/workspaces/{workspaceId}/experiments", "Create an experiment", experimentSchema, workspacePath, experimentCreate, 201),
  read("getExperiment", "/api/v1/workspaces/{workspaceId}/experiments/{id}", "Get an experiment", experimentSchema, itemPath),
  write("PATCH", "updateExperiment", "/api/v1/workspaces/{workspaceId}/experiments/{id}", "Update an experiment with optimistic concurrency", experimentSchema, itemPath, experimentPatch),
  read("listExperimentResults", "/api/v1/workspaces/{workspaceId}/experiments/{id}/results", "List experiment results", collectionOf(experimentResultSchema), itemPath, cursorQuery.strict()),
  write("POST", "createExperimentResult", "/api/v1/workspaces/{workspaceId}/experiments/{id}/results", "Record an experiment result", experimentResultSchema, itemPath, experimentResultCreate, 201),
  write("POST", "concludeExperiment", "/api/v1/workspaces/{workspaceId}/experiments/{id}/conclusion", "Conclude an experiment", experimentSchema, itemPath, experimentConclusion),

  read("listMetrics", "/api/v1/workspaces/{workspaceId}/metrics", "List metric definitions", collectionOf(metricSchema), workspacePath, cursorQuery.strict()),
  write("POST", "createMetric", "/api/v1/workspaces/{workspaceId}/metrics", "Create a metric definition", metricSchema, workspacePath, metricInputSchema, 201),
  read("getMetric", "/api/v1/workspaces/{workspaceId}/metrics/{id}", "Get a metric definition", metricSchema, itemPath),
  write("PATCH", "updateMetric", "/api/v1/workspaces/{workspaceId}/metrics/{id}", "Create a metric revision", metricSchema, itemPath, metricPatch),
  write("DELETE", "archiveMetric", "/api/v1/workspaces/{workspaceId}/metrics/{id}", "Archive a metric definition", z.undefined(), itemPath, undefined, 204),
  read("listMetricBindings", "/api/v1/workspaces/{workspaceId}/metric-bindings", "List metric bindings", collectionOf(metricBindingSchema), workspacePath, cursorQuery.merge(targetSchema).strict()),
  write("POST", "createMetricBinding", "/api/v1/workspaces/{workspaceId}/metric-bindings", "Bind a metric", metricBindingSchema, workspacePath, linkMetricSchema, 201),
  read("getMetricBinding", "/api/v1/workspaces/{workspaceId}/metric-bindings/{id}", "Get a metric binding", metricBindingSchema, itemPath),
  write("PATCH", "updateMetricBinding", "/api/v1/workspaces/{workspaceId}/metric-bindings/{id}", "Replace a metric binding revision", metricBindingSchema, itemPath, updateMetricBindingSchema),
  write("DELETE", "deleteMetricBinding", "/api/v1/workspaces/{workspaceId}/metric-bindings/{id}", "Deactivate a metric binding", z.undefined(), itemPath, undefined, 204),
  write("POST", "refreshMetricBinding", "/api/v1/workspaces/{workspaceId}/metric-bindings/{id}/refresh", "Refresh metric observations idempotently", z.array(metricObservationSchema), itemPath, z.object({ requestId: uuid }).strict()),
  read("listMetricObservations", "/api/v1/workspaces/{workspaceId}/metric-bindings/{id}/metric-observations", "List metric observations", collectionOf(metricObservationSchema), itemPath, cursorQuery.strict()),
  read("getMetricObservation", "/api/v1/workspaces/{workspaceId}/metric-observations/{id}", "Get a metric observation", metricObservationSchema, itemPath),

  read("listScoringModels", "/api/v1/workspaces/{workspaceId}/scoring-models", "List scoring models available to a workspace", collectionOf(scoringModelSchema), workspacePath, cursorQuery.strict()),
  write("POST", "createScoringModel", "/api/v1/workspaces/{workspaceId}/scoring-models", "Create an organization scoring model", scoringModelSchema, workspacePath, scoringModelCreate, 201),
  read("getScoringModel", "/api/v1/workspaces/{workspaceId}/scoring-models/{id}", "Get a scoring model", scoringModelSchema, itemPath),
  write("PATCH", "updateScoringModel", "/api/v1/workspaces/{workspaceId}/scoring-models/{id}", "Update a scoring model atomically", scoringModelSchema, itemPath, scoringModelPatch),
  write("DELETE", "archiveScoringModel", "/api/v1/workspaces/{workspaceId}/scoring-models/{id}", "Archive a scoring model", z.undefined(), itemPath, undefined, 204),
  write("POST", "scoreOpportunity", "/api/v1/workspaces/{workspaceId}/opportunities/{id}/opportunity-scores", "Score an opportunity", scoreSchema, itemPath, scoreCreate, 201),
  read("getOpportunityScore", "/api/v1/workspaces/{workspaceId}/opportunities/{id}/opportunity-scores", "Get an opportunity score", scoreSchema, itemPath),
  write("POST", "scoreSolution", "/api/v1/workspaces/{workspaceId}/solutions/{id}/solution-scores", "Score a solution", scoreSchema, itemPath, scoreCreate, 201),
  read("getSolutionScore", "/api/v1/workspaces/{workspaceId}/solutions/{id}/solution-scores", "Get a solution score", scoreSchema, itemPath),

  read("listSquads", "/api/v1/workspaces/{workspaceId}/squads", "List squads", collectionOf(squadSchema), workspacePath, cursorQuery.strict()),
  write("POST", "createSquad", "/api/v1/workspaces/{workspaceId}/squads", "Create a squad", squadSchema, workspacePath, squadCreate, 201),
  read("getSquad", "/api/v1/workspaces/{workspaceId}/squads/{id}", "Get a squad", squadSchema, itemPath),
  write("PATCH", "updateSquad", "/api/v1/workspaces/{workspaceId}/squads/{id}", "Update a squad", squadSchema, itemPath, squadCreate.partial().strict()),
  read("listCustomFieldDefinitions", "/api/v1/workspaces/{workspaceId}/custom-field-definitions", "List custom-field definitions", collectionOf(customFieldDefinitionSchema), workspacePath, cursorQuery.extend({ objectType: customObjectType.optional() }).strict()),
  read("listCustomFieldValues", "/api/v1/workspaces/{workspaceId}/custom-field-values/{objectType}/{objectId}", "List custom-field values", collectionOf(customFieldValueSchema), customValuePath, cursorQuery.strict()),
  write("POST", "setCustomFieldValue", "/api/v1/workspaces/{workspaceId}/custom-field-values/{objectType}/{objectId}", "Set a custom-field value", customFieldValueSchema, customValuePath, customFieldValueCreate),
  read("listEntityLinks", "/api/v1/workspaces/{workspaceId}/entity-links", "List typed entity links", collectionOf(typedLinkSchema), workspacePath, entityLinksQuery),
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
