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
import { COMMENT_TARGET_TYPES } from "@/lib/comments"
import { ACTIVE_FOLLOWABLE_SUBJECT_TYPES } from "@/lib/followable"
import { DOC_TYPES } from "@/lib/doc-types"
import { DOC_IMAGE_ALLOWED_MIME_TYPES, DOC_IMAGE_MAX_BYTES } from "@/lib/doc-images"
import { decisionOptionsInputSchema, decisionQuestionsInputSchema } from "@/lib/decision-option-schema"

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
const urlBoolean = z.enum(["true", "false"]).transform((value) => value === "true")
const timestamp = z.string().datetime()
const commentResponse = z.object({ id: uuid, workspaceId: uuid, targetType: z.enum(COMMENT_TARGET_TYPES), targetId: uuid, parentId: uuid.nullable(), body: z.string(), status: z.enum(["OPEN", "RESOLVED"]), authorId: uuid.nullable(), authorName: z.string(), authorType: z.enum(["AGENT", "HUMAN"]), source: z.string(), createdAt: timestamp, updatedAt: timestamp, docAnchor: z.object({ commentId: uuid, anchorText: z.string(), anchorPrefix: z.string().nullable(), anchorSuffix: z.string().nullable(), anchorStart: z.number().int().nullable(), anchorEnd: z.number().int().nullable() }).nullable().optional(), solutionPlanProposal: z.object({ commentId: uuid, trackedDecisionRequestId: uuid.nullable(), legacyPlanStatus: z.string().nullable() }).nullable().optional(), elementAnchor: z.object({ commentId: uuid, artifactId: uuid, artifactRevisionId: uuid.nullable(), pageUrl: z.string(), pagePath: z.string(), elementSelector: z.string().nullable(), elementFingerprint: z.unknown().nullable(), screenshotUrl: z.string().nullable() }).nullable().optional(), externalAuthor: z.object({ commentId: uuid, submitterEmail: z.string().nullable(), portalAccountId: uuid.nullable(), embedTokenId: uuid.nullable() }).nullable().optional() }).strict()
const docCommentResponse = z.object({ id: uuid, docId: uuid, parentId: uuid.nullable(), body: z.string(), status: z.enum(["OPEN", "RESOLVED"]), anchorText: z.string().nullable(), anchorPrefix: z.string().nullable(), anchorSuffix: z.string().nullable(), anchorStart: z.number().int().nullable(), anchorEnd: z.number().int().nullable(), authorId: uuid.nullable(), authorName: z.string(), authorType: z.enum(["AGENT", "HUMAN"]), source: z.string(), createdAt: timestamp, updatedAt: timestamp }).strict()
const notificationResponse = z.object({ id: uuid, kind: z.string(), subjectType: z.enum(ACTIVE_FOLLOWABLE_SUBJECT_TYPES), subjectId: uuid, actor: z.object({ type: z.string(), id: uuid.nullable(), name: z.string() }).strict(), payload: z.record(z.string(), z.string()), read: z.boolean(), readAt: timestamp.nullable(), createdAt: timestamp, subject: z.object({ title: z.string(), path: z.string() }).strict().nullable() }).strict()
const notificationCollection = z.object({ items: z.array(notificationResponse), nextCursor: z.string().nullable(), unreadCount: z.number().int().nonnegative(), unreadOverflow: z.boolean() }).strict()
const followResponse = z.object({ subjectType: z.enum(ACTIVE_FOLLOWABLE_SUBJECT_TYPES), subjectId: uuid, status: z.enum(["followed", "already_following", "unfollowed"]) }).strict()
const markReadResponse = z.object({ marked: z.number().int().nonnegative() }).strict()
const docSummary = z.object({ id: uuid, workspaceId: uuid, title: z.string(), parentId: uuid.nullable(), icon: z.string().nullable(), docType: z.enum(DOC_TYPES), roadmapItemId: uuid.nullable(), revision: z.union([z.string(), z.number()]), createdAt: timestamp, updatedAt: timestamp }).strict()
const docCreateResponse = z.object({ id: uuid, title: z.string(), url: z.string().url().nullable(), revision: z.union([z.string(), z.number()]), storageProvider: z.string() }).strict()
const docUpdateResponse = z.object({ id: uuid, title: z.string(), icon: z.string().nullable(), updatedAt: timestamp, revision: z.union([z.string(), z.number()]) }).strict()
const docDetailResponse = z.object({ id: uuid, title: z.string(), docType: z.enum(DOC_TYPES), content: z.string(), properties: z.record(z.string(), z.unknown()).nullable(), revision: z.union([z.string(), z.number()]), storageProvider: z.string() }).strict()
const docVersionSummary = z.object({ id: uuid, docId: uuid, label: z.string().nullable(), createdByName: z.string().nullable(), createdAt: timestamp }).strict()
const docVersionMutation = z.object({ id: uuid, label: z.string().nullable().optional() }).strict()
const docVersionDetail = z.object({ id: uuid, docId: uuid.optional(), title: z.string(), content: z.string().nullable().optional(), storageProvider: z.string().nullable().optional(), metadata: z.record(z.string(), z.unknown()).nullable().optional(), icon: z.string().nullable().optional(), label: z.string().nullable().optional(), createdById: uuid.nullable().optional(), createdByName: z.string().nullable().optional(), createdAt: timestamp.optional(), restoredFrom: timestamp.optional(), revision: z.union([z.string(), z.number()]).optional() }).strict()
const artifactSummary = z.object({ id: uuid, workspaceId: uuid, title: z.string(), description: z.string().nullable(), sourceType: z.enum(["HTML_UPLOAD", "EXTERNAL_LINK"]), status: z.enum(["ACTIVE", "ARCHIVED"]), currentRevisionId: uuid.nullable(), createdById: uuid.nullable().optional(), updatedById: uuid.nullable().optional(), source: z.string().optional(), createdAt: timestamp, updatedAt: timestamp }).strict()
const artifactRevisionResponse = z.object({ id: uuid, artifactId: uuid, revisionNumber: z.number().int().positive(), filename: z.string().nullable(), mimeType: z.string().nullable(), byteSize: z.number().int().nullable(), sha256: z.string().nullable(), externalUrl: z.string().url().nullable(), createdById: uuid.nullable(), source: z.string(), createdAt: timestamp }).strict()
const artifactMutation = z.object({ id: uuid, title: z.string().optional(), sourceType: z.enum(["HTML_UPLOAD", "EXTERNAL_LINK"]).optional(), revisionId: uuid.optional(), linkId: uuid.optional(), created: z.boolean().optional(), artifactId: uuid.optional(), solutionId: uuid.optional(), requestId: uuid.optional(), workspaceId: uuid.optional() }).strict()
const artifactDecisionLinkResponse = z.object({ workspaceId: uuid, artifactId: uuid, requestId: uuid, linkId: uuid, created: z.boolean() }).strict()
const decisionOptionResponse = z.object({ id: uuid.optional(), actionKey: z.string().optional(), label: z.string(), description: z.string().nullable().optional(), outcomeClass: z.string().optional() }).strict()
const persistedDecisionOptionResponse = z.object({ id: uuid, revisionId: uuid, actionKey: z.string(), label: z.string(), description: z.string().nullable(), outcomeClass: z.string(), continuationKey: z.string(), sortOrder: z.number().int(), createdAt: timestamp }).strict()
const decisionRecordResponse = z.object({ id: uuid, workspaceId: uuid, requestId: uuid, revisionId: uuid, optionId: uuid, fingerprint: z.string(), actorUserId: uuid, actorRole: z.string(), rationale: z.string().nullable(), answersJson: z.string().nullable(), idempotencyKey: z.string(), decidedAt: timestamp, option: persistedDecisionOptionResponse.optional() }).strict()
const decisionRevisionResponse: z.ZodTypeAny = z.object({ id: uuid, requestId: uuid, revisionNumber: z.number().int().positive(), sourceFingerprint: z.string().nullable(), fingerprint: z.string(), title: z.string(), summary: z.string().nullable(), packetJson: z.string(), requiredRole: z.string(), expiresAt: timestamp.nullable(), createdAt: timestamp, supersededAt: timestamp.nullable(), reviewUrl: z.string().url().nullable().optional(), options: z.array(persistedDecisionOptionResponse).optional(), decisions: z.array(decisionRecordResponse).optional(), chosenOption: decisionOptionResponse.nullable().optional(), questions: z.array(z.unknown()).optional(), answers: z.array(z.unknown()).optional() }).strict()
const decisionRevisionSummaryResponse = z.object({ title: z.string(), fingerprint: z.string() }).strict()
const linkedDecisionArtifactResponse = z.object({ id: uuid, title: z.string(), sourceType: z.enum(["HTML_UPLOAD", "EXTERNAL_LINK"]), status: z.enum(["ACTIVE", "ARCHIVED"]), currentRevision: z.object({ revisionNumber: z.number().int().positive() }).strict().nullable() }).strict()
const decisionRequestResponse = z.object({ id: uuid, workspaceId: uuid, gateType: z.string(), subjectType: z.string(), subjectId: uuid, state: z.string(), currentRevisionId: uuid.nullable(), revisionCount: z.number().int().nonnegative(), decisionCycle: z.number().int().nonnegative(), requestedById: uuid.nullable(), requestedByAgentId: uuid.nullable(), assignedToId: uuid.nullable(), dueAt: timestamp.nullable(), expiresAt: timestamp.nullable(), reopenReason: z.string().nullable(), reopenedById: uuid.nullable(), reconsidersDecisionId: uuid.nullable(), noActionAt: timestamp.nullable(), noActionById: uuid.nullable(), noActionReason: z.string().nullable(), createdAt: timestamp, updatedAt: timestamp, currentRevision: z.union([decisionRevisionResponse, decisionRevisionSummaryResponse]).nullable().optional(), revisions: z.array(decisionRevisionResponse).optional(), reviewUrl: z.string().url().nullable().optional(), requestedBy: z.object({ type: z.string(), id: uuid, name: z.string() }).strict().nullable().optional(), followUpTasks: z.array(z.object({ id: uuid, title: z.string(), status: z.string() }).strict()).optional(), noAction: z.object({ at: timestamp, reason: z.string().nullable() }).strict().nullable().optional(), options: z.array(decisionOptionResponse).optional(), chosenOption: decisionOptionResponse.nullable().optional(), questions: z.array(z.unknown()).optional(), answers: z.array(z.unknown()).optional(), artifacts: z.array(linkedDecisionArtifactResponse).optional() }).strict()
const releaseAuthorizationResponse = z.object({ status: z.literal("READY"), requestId: uuid, releaseRunId: uuid, revisionId: uuid, sourceFingerprint: z.string(), reviewFingerprint: z.string(), reviewUrl: z.string().url().nullable() }).strict()
const reviewResponse = decisionRequestResponse
const solutionPlanResponse = z.object({ id: uuid, solutionId: uuid, parentId: uuid.nullable().optional(), body: z.string(), commentType: z.string(), planStatus: z.string().nullable().optional(), authorName: z.string(), authorType: z.string(), source: z.string(), createdAt: timestamp, updatedAt: timestamp }).strict()
const launchItemResponse = z.object({ id: uuid, label: z.string(), status: z.enum(["PENDING", "DONE", "SKIPPED"]) }).strict()
const launchTierResponse = z.object({ item: z.object({ id: uuid, title: z.string(), tier: z.enum(["TIER_1", "TIER_2", "TIER_3"]), horizon: z.literal("LAUNCHING") }).strict(), checklist: z.object({ id: uuid, name: z.string(), tier: z.enum(["TIER_1", "TIER_2", "TIER_3"]), itemCount: z.number().int().nonnegative() }).strict() }).strict()
const launchChecklistResponse = z.object({ items: z.array(launchItemResponse), count: z.number().int().nonnegative() }).strict()
const releaseRunResponse = z.object({ id: uuid, state: z.enum(["PREPARING", "READY_FOR_APPROVAL", "DECISION_RECORDING", "DISPATCH_QUEUED", "BLOCKED", "SUPERSEDED", "CANCELLED"]), provider: z.literal("GITHUB"), repositoryOwner: z.string(), repositoryName: z.string(), pullRequestNumber: z.number().int().positive(), pullRequestUrl: z.string().url(), baseRef: z.string(), headSha: z.string(), targetEnvironment: z.string(), releasePolicyId: z.string(), sourceFingerprint: z.string(), authorizationDecisionRecordId: uuid.nullable(), taskIds: z.array(uuid), dispatches: z.array(z.object({ id: uuid, status: z.string(), updatedAt: timestamp }).strict()), lastErrorCode: z.string().nullable(), createdAt: timestamp, updatedAt: timestamp }).strict()
const docImagePreparation = z.object({ imageId: uuid, imageName: z.string(), pathname: z.string(), url: z.string().regex(/^\/api\/docs\/images\//), filename: z.string(), fileType: z.enum(DOC_IMAGE_ALLOWED_MIME_TYPES), fileSize: z.number().int().positive(), clientToken: z.string().min(1), expiresAt: z.union([z.string(), z.number()]), access: z.literal("private"), markdown: z.string() })
const commentTarget = z.enum(COMMENT_TARGET_TYPES)
const commentTargetPath = z.object({ workspaceId: uuid, targetType: commentTarget, targetId: uuid })
const commentCreate = z.object({ body: z.string().trim().min(1), parentId: uuid.optional() }).strict()
const commentPatch = z.object({ body: z.string().trim().min(1) }).strict()
const followPath = z.object({ workspaceId: uuid, subjectType: z.enum(ACTIVE_FOLLOWABLE_SUBJECT_TYPES), subjectId: uuid })
const docCreate = z.object({ title: z.string().trim().min(1).max(255), content: z.string().optional(), parentId: uuid.nullable().optional(), icon: z.string().max(32).optional(), roadmapItemId: uuid.nullable().optional(), docType: z.enum(DOC_TYPES).optional(), operationId: uuid }).strict()
const docPatch = z.object({ title: z.string().trim().min(1).max(255).optional(), content: z.string().optional(), icon: z.string().max(32).optional(), expectedRevision: z.string().min(1), operationId: uuid }).strict()
const docUpload = z.object({ filename: z.string().trim().min(1).max(255), fileType: z.enum(DOC_IMAGE_ALLOWED_MIME_TYPES), fileSize: z.number().int().min(1).max(DOC_IMAGE_MAX_BYTES) }).strict()
const versionCreate = z.object({ label: z.string().trim().max(255).optional(), expectedRevision: z.string().min(1), operationId: uuid }).strict()
const restoreVersion = z.object({ expectedRevision: z.string().min(1), operationId: uuid }).strict()
const docCommentCreate = commentCreate.extend({ anchorText: z.string().optional(), anchorPrefix: z.string().optional(), anchorSuffix: z.string().optional(), anchorStart: z.number().int().nonnegative().optional(), anchorEnd: z.number().int().nonnegative().optional() }).strict()
const artifactCreate = z.union([
  z.object({ title: z.string().trim().min(1).max(255), description: z.string().optional(), sourceType: z.literal("HTML_UPLOAD"), html: z.string().min(1), filename: z.string().max(255).optional() }).strict(),
  z.object({ title: z.string().trim().min(1).max(255), description: z.string().optional(), sourceType: z.literal("EXTERNAL_LINK"), url: z.string().url() }).strict(),
])
const artifactPatch = z.object({ title: z.string().trim().min(1).max(255).optional(), description: z.string().nullable().optional(), html: z.string().min(1).optional(), filename: z.string().max(255).optional(), url: z.string().url().optional() }).strict()
const decisionSubject = z.enum(["WORKSPACE", "OPPORTUNITY", "SOLUTION", "ROADMAP_ITEM", "DOC", "EXPERIMENT", "FEEDBACK"])
const decisionSource = z.enum(["WORKSPACE", "OPPORTUNITY", "SOLUTION", "ASSUMPTION", "ROADMAP_ITEM", "DOC", "EXPERIMENT", "FEEDBACK", "EVIDENCE"])
const decisionRequest = z.object({ subjectType: decisionSubject, subjectId: uuid, question: z.string().trim().min(1).max(255), context: z.string().trim().min(1).max(20_000), sources: z.array(z.object({ type: decisionSource, id: uuid }).strict()).max(12).optional(), options: decisionOptionsInputSchema, questions: decisionQuestionsInputSchema, idempotencyKey: uuid.optional() }).strict().refine(value => !(value.options && value.questions), { message: "options and questions are mutually exclusive" })
const solutionPlanCreate = z.object({ body: z.string().trim().min(1) }).strict()
const solutionPlanCommentCreate = z.object({ body: z.string().trim().min(1) }).strict()
const launchTierCreate = z.object({ tier: z.enum(["TIER_1", "TIER_2", "TIER_3"]) }).strict()
const checklistPatch = z.object({ status: z.enum(["PENDING", "DONE", "SKIPPED"]) }).strict()
const releaseAuthorizationRequest = z.object({ provider: z.literal("GITHUB"), repositoryOwner: z.string().trim().min(1).max(255), repositoryName: z.string().trim().min(1).max(255), pullRequestNumber: z.number().int().positive(), baseRef: z.string().trim().min(1).max(255), headSha: z.string().regex(/^[a-f0-9]{40}$/i), targetEnvironment: z.literal("PRODUCTION"), releasePolicyId: z.string().trim().min(1).max(255), taskIds: z.array(uuid).min(1) }).strict()

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
  read("listCustomFieldDefinitions", "/api/v1/workspaces/{workspaceId}/custom-field-definitions", "List custom-field definitions in configured display order", collectionOf(customFieldDefinitionSchema), workspacePath, cursorQuery.extend({ objectType: customObjectType.optional() }).strict()),
  read("listCustomFieldValues", "/api/v1/workspaces/{workspaceId}/custom-field-values/{objectType}/{objectId}", "List custom-field values in configured display order", collectionOf(customFieldValueSchema), customValuePath, cursorQuery.strict()),
  write("POST", "setCustomFieldValue", "/api/v1/workspaces/{workspaceId}/custom-field-values/{objectType}/{objectId}", "Set a custom-field value", customFieldValueSchema, customValuePath, customFieldValueCreate),
  read("listEntityLinks", "/api/v1/workspaces/{workspaceId}/entity-links", "List typed entity links", collectionOf(typedLinkSchema), workspacePath, entityLinksQuery),

  read("listComments", "/api/v1/workspaces/{workspaceId}/comments/{targetType}/{targetId}", "List comments and replies", collectionOf(commentResponse), commentTargetPath, cursorQuery.extend({ status: z.enum(["OPEN", "RESOLVED"]).optional() }).strict()),
  write("POST", "createComment", "/api/v1/workspaces/{workspaceId}/comments/{targetType}/{targetId}", "Create a comment or reply", z.union([commentResponse, docCommentResponse]), commentTargetPath, commentCreate, 201),
  read("getComment", "/api/v1/workspaces/{workspaceId}/comments/{id}", "Get a comment", commentResponse, itemPath),
  write("PATCH", "updateComment", "/api/v1/workspaces/{workspaceId}/comments/{id}", "Update a comment", z.union([commentResponse, docCommentResponse]), itemPath, commentPatch),
  write("DELETE", "deleteComment", "/api/v1/workspaces/{workspaceId}/comments/{id}", "Delete a comment and its replies", z.undefined(), itemPath, undefined, 204),
  write("POST", "resolveComment", "/api/v1/workspaces/{workspaceId}/comments/{id}/resolution", "Resolve a comment", z.union([commentResponse, docCommentResponse]), itemPath),
  write("DELETE", "reopenComment", "/api/v1/workspaces/{workspaceId}/comments/{id}/resolution", "Reopen a comment", z.union([commentResponse, docCommentResponse]), itemPath),
  write("POST", "followResource", "/api/v1/workspaces/{workspaceId}/follows/{subjectType}/{subjectId}", "Follow a resource", followResponse, followPath, undefined, 201),
  write("DELETE", "unfollowResource", "/api/v1/workspaces/{workspaceId}/follows/{subjectType}/{subjectId}", "Unfollow a resource", z.undefined(), followPath, undefined, 204),
  read("listNotifications", "/api/v1/workspaces/{workspaceId}/notifications", "List the current human user's notifications", notificationCollection, workspacePath, cursorQuery.extend({ unreadOnly: urlBoolean.optional() }).strict()),
  write("POST", "markNotificationsRead", "/api/v1/workspaces/{workspaceId}/notifications/read", "Mark owned notifications read", markReadResponse, workspacePath, z.union([z.object({ notificationIds: z.array(uuid).min(1) }).strict(), z.object({ all: z.literal(true) }).strict()])),

  read("listDocs", "/api/v1/workspaces/{workspaceId}/docs", "List documents", collectionOf(docSummary), workspacePath, cursorQuery.strict()),
  write("POST", "createDoc", "/api/v1/workspaces/{workspaceId}/docs", "Create a document with an idempotent operation token", docCreateResponse, workspacePath, docCreate, 201),
  read("getDoc", "/api/v1/workspaces/{workspaceId}/docs/{id}", "Get a document", docDetailResponse, itemPath),
  write("PATCH", "updateDoc", "/api/v1/workspaces/{workspaceId}/docs/{id}", "Update a document with required optimistic concurrency and operation tokens", docUpdateResponse, itemPath, docPatch),
  write("POST", "prepareDocImageUpload", "/api/v1/workspaces/{workspaceId}/docs/{id}/image-uploads", "Prepare a private document image upload", docImagePreparation, itemPath, docUpload, 201),
  read("listDocVersions", "/api/v1/workspaces/{workspaceId}/docs/{id}/versions", "List document versions", collectionOf(docVersionSummary), itemPath, cursorQuery.strict()),
  write("POST", "createDocVersion", "/api/v1/workspaces/{workspaceId}/docs/{id}/versions", "Create a named document version with required concurrency and operation tokens", docVersionMutation, itemPath, versionCreate, 201),
  read("getDocVersion", "/api/v1/workspaces/{workspaceId}/doc-versions/{id}", "Get a document version", docVersionDetail, itemPath),
  write("POST", "restoreDocVersion", "/api/v1/workspaces/{workspaceId}/doc-versions/{id}/restore", "Restore a document version with required concurrency and operation tokens", docVersionDetail, itemPath, restoreVersion),
  read("listDocComments", "/api/v1/workspaces/{workspaceId}/docs/{id}/comments", "List document comments and replies", collectionOf(docCommentResponse), itemPath, cursorQuery.extend({ status: z.enum(["OPEN", "RESOLVED"]).optional() }).strict()),
  write("POST", "createDocComment", "/api/v1/workspaces/{workspaceId}/docs/{id}/comments", "Create a document comment or reply", docCommentResponse, itemPath, docCommentCreate, 201),
  read("getDocComment", "/api/v1/workspaces/{workspaceId}/doc-comments/{id}", "Get a document comment", docCommentResponse, itemPath),
  write("PATCH", "updateDocComment", "/api/v1/workspaces/{workspaceId}/doc-comments/{id}", "Update a document comment", docCommentResponse, itemPath, commentPatch),
  write("DELETE", "deleteDocComment", "/api/v1/workspaces/{workspaceId}/doc-comments/{id}", "Delete a document comment and replies", z.undefined(), itemPath, undefined, 204),
  write("POST", "resolveDocComment", "/api/v1/workspaces/{workspaceId}/doc-comments/{id}/resolution", "Resolve a document comment", docCommentResponse, itemPath),
  write("DELETE", "reopenDocComment", "/api/v1/workspaces/{workspaceId}/doc-comments/{id}/resolution", "Reopen a document comment", docCommentResponse, itemPath),

  read("listArtifacts", "/api/v1/workspaces/{workspaceId}/artifacts", "List artifacts", collectionOf(artifactSummary), workspacePath, cursorQuery.extend({ includeArchived: urlBoolean.optional() }).strict()),
  write("POST", "createArtifact", "/api/v1/workspaces/{workspaceId}/artifacts", "Create an artifact", artifactMutation, workspacePath, artifactCreate, 201),
  read("getArtifact", "/api/v1/workspaces/{workspaceId}/artifacts/{id}", "Get an artifact without private storage keys", artifactSummary.extend({ currentRevision: artifactRevisionResponse.nullable(), revisions: z.array(artifactRevisionResponse), solutions: z.array(z.object({ id: uuid, title: z.string() }).strict()), decisions: z.array(z.object({ id: uuid, title: z.string(), state: z.string().optional() }).strict()) }), itemPath),
  write("PATCH", "updateArtifact", "/api/v1/workspaces/{workspaceId}/artifacts/{id}", "Update an artifact", artifactSummary.extend({ currentRevision: artifactRevisionResponse.nullable(), revisions: z.array(artifactRevisionResponse), solutions: z.array(z.object({ id: uuid, title: z.string() }).strict()), decisions: z.array(z.object({ id: uuid, title: z.string(), state: z.string().optional() }).strict()) }), itemPath, artifactPatch),
  write("DELETE", "archiveArtifact", "/api/v1/workspaces/{workspaceId}/artifacts/{id}", "Archive an artifact", z.undefined(), itemPath, undefined, 204),
  write("POST", "linkArtifactSolution", "/api/v1/workspaces/{workspaceId}/artifacts/{id}/solutions", "Link an artifact to a solution", artifactMutation, itemPath, z.object({ solutionId: uuid }).strict(), 201),
  write("DELETE", "unlinkArtifactSolution", "/api/v1/workspaces/{workspaceId}/artifacts/{id}/solutions/{relatedId}", "Unlink an artifact from a solution", z.undefined(), relatedItemPath, undefined, 204),
  write("POST", "linkArtifactDecision", "/api/v1/workspaces/{workspaceId}/artifacts/{id}/decisions", "Link an artifact to a decision request", artifactDecisionLinkResponse, itemPath, z.object({ requestId: uuid }).strict(), 201),
  write("DELETE", "unlinkArtifactDecision", "/api/v1/workspaces/{workspaceId}/artifacts/{id}/decisions/{relatedId}", "Unlink an artifact from a decision request", z.undefined(), relatedItemPath, undefined, 204),

  write("POST", "requestDecision", "/api/v1/workspaces/{workspaceId}/decision-requests", "Request an immutable human decision", decisionRevisionResponse, workspacePath, decisionRequest, 201),
  read("listDecisions", "/api/v1/workspaces/{workspaceId}/decision-requests", "List decision requests", collectionOf(decisionRequestResponse), workspacePath, cursorQuery.extend({ limit: z.coerce.number().int().min(1).max(50).default(50), status: z.string().max(50).optional() }).strict()),
  read("getDecision", "/api/v1/workspaces/{workspaceId}/decision-requests/{id}", "Get a decision request", decisionRequestResponse, itemPath),
  read("listReviewRequests", "/api/v1/workspaces/{workspaceId}/review-requests", "List human review requests", collectionOf(reviewResponse), workspacePath, cursorQuery.extend({ state: z.string().max(50).optional() }).strict()),
  read("getReviewRequest", "/api/v1/workspaces/{workspaceId}/review-requests/{id}", "Get a human review request", reviewResponse, itemPath),
  read("listSolutionPlanEntries", "/api/v1/workspaces/{workspaceId}/solutions/{id}/plan-entries", "List proposed solution plan entries and discussion", collectionOf(solutionPlanResponse), itemPath, cursorQuery.strict()),
  write("POST", "createSolutionPlan", "/api/v1/workspaces/{workspaceId}/solutions/{id}/plan-entries", "Create a proposed solution plan", solutionPlanResponse, itemPath, solutionPlanCreate, 201),
  read("getSolutionPlanEntry", "/api/v1/workspaces/{workspaceId}/solution-plan-entries/{id}", "Get a solution plan entry", solutionPlanResponse, itemPath),
  write("POST", "createSolutionPlanComment", "/api/v1/workspaces/{workspaceId}/solutions/{id}/plan-comments", "Create a top-level plan discussion comment", solutionPlanResponse, itemPath, solutionPlanCommentCreate, 201),
  write("PATCH", "updateSolutionPlanEntry", "/api/v1/workspaces/{workspaceId}/solution-plan-entries/{id}", "Update a proposed solution plan entry", solutionPlanResponse, itemPath, commentPatch),
  write("DELETE", "deleteSolutionPlanEntry", "/api/v1/workspaces/{workspaceId}/solution-plan-entries/{id}", "Delete a proposed solution plan entry", z.undefined(), itemPath, undefined, 204),

  write("POST", "setLaunchTier", "/api/v1/workspaces/{workspaceId}/roadmap-items/{id}/launch-checklist", "Set a roadmap item's launch tier atomically", launchTierResponse, itemPath, launchTierCreate),
  read("getLaunchChecklist", "/api/v1/workspaces/{workspaceId}/roadmap-items/{id}/launch-checklist", "Get a roadmap item's launch checklist", launchChecklistResponse, itemPath),
  write("PATCH", "updateLaunchChecklistItem", "/api/v1/workspaces/{workspaceId}/launch-checklist-items/{id}", "Update a launch checklist item", launchItemResponse.pick({ id: true, status: true }).strict(), itemPath, checklistPatch),
  write("POST", "requestReleaseAuthorization", "/api/v1/workspaces/{workspaceId}/release-authorizations", "Request human release authorization without dispatching", releaseAuthorizationResponse, workspacePath, releaseAuthorizationRequest, 201),
  read("listReleaseRuns", "/api/v1/workspaces/{workspaceId}/release-runs", "List release runs", collectionOf(releaseRunResponse), workspacePath, cursorQuery.extend({ state: z.enum(["PREPARING", "READY_FOR_APPROVAL", "DECISION_RECORDING", "DISPATCH_QUEUED", "BLOCKED", "SUPERSEDED", "CANCELLED"]).optional(), taskId: uuid.optional(), updatedSince: z.string().datetime().optional() }).strict()),
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
