import { z } from "zod"

export const uuid = z.string().uuid()
export const cursorQuery = z.object({
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export const resourceSchema = z.object({
  id: uuid,
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const collectionOf = (item: z.ZodType) => z.object({ items: z.array(item), nextCursor: z.string().nullable() })

export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string(),
  instance: z.string(),
  code: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
})

export const workspaceSchema = resourceSchema.extend({
  organizationId: uuid,
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
})

export const opportunitySchema = resourceSchema.extend({
  workspaceId: uuid,
  title: z.string(),
  description: z.string().nullable(),
  customerSegment: z.string().nullable(),
  status: z.enum(["EXPLORING", "VALIDATING", "PRIORITIZED", "ACTIVE", "ARCHIVED"]),
  squadId: uuid.nullable(),
  linkedKeyResultId: uuid.nullable(),
})

export const solutionSchema = resourceSchema.extend({
  workspaceId: uuid,
  opportunityId: uuid,
  title: z.string(),
  description: z.string().nullable(),
  status: z.enum(["IDEA", "VALIDATED", "IN_DELIVERY", "SHIPPED", "KILLED"]),
})

export const assumptionSchema = resourceSchema.extend({
  solutionId: uuid,
  title: z.string(),
  description: z.string().nullable(),
  riskLevel: z.enum(["HIGH", "MEDIUM", "LOW"]),
  status: z.enum(["UNTESTED", "TESTING", "VALIDATED", "INVALIDATED"]),
})

export const feedbackSchema = resourceSchema.extend({
  workspaceId: uuid,
  opportunityId: uuid.nullable(),
  title: z.string(),
  description: z.string().nullable(),
  type: z.string(),
  status: z.string(),
  voteCount: z.number().int(),
  tags: z.array(z.string()),
  submitterName: z.string().nullable(),
  submitterEmail: z.string().nullable(),
})

export const taskSchema = resourceSchema.extend({
  workspaceId: uuid,
  squadId: uuid.nullable(),
  parentTaskId: uuid.nullable(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  priority: z.string(),
  assigneeUserId: uuid.nullable(),
  assigneeAgentId: uuid.nullable(),
  ownerName: z.string().nullable(),
  storyPoints: z.number().nullable(),
  dueDate: z.string().nullable(),
  iteration: z.string().nullable(),
})

export const roadmapItemSchema = resourceSchema.extend({
  workspaceId: uuid,
  squadId: uuid.nullable(),
  title: z.string(),
  description: z.string().nullable(),
  horizon: z.string(),
  status: z.string(),
  isPrivate: z.boolean(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  solutionId: uuid.nullable(),
  keyResultId: uuid.nullable(),
  opportunityId: uuid.nullable(),
  experimentId: uuid.nullable(),
  feedbackId: uuid.nullable(),
})

export const typedLinkSchema = z.object({
  id: uuid,
  source: z.string(),
  kind: z.enum(["opportunity_objective", "solution_key_result"]),
  opportunityId: uuid.optional(),
  opportunityTitle: z.string().optional(),
  objectiveId: uuid.optional(),
  objectiveTitle: z.string().optional(),
  origin: z.string().optional(),
  solutionId: uuid.optional(),
  solutionTitle: z.string().optional(),
  keyResultId: uuid.optional(),
  keyResultTitle: z.string().optional(),
  createdAt: z.string(),
})

export const opportunityObjectiveRelationshipSchema = z.object({
  id: uuid, workspaceId: uuid, opportunityId: uuid, objectiveId: uuid,
  origin: z.string(), source: z.string(),
})

export const solutionKeyResultRelationshipSchema = z.object({
  id: uuid, workspaceId: uuid, solutionId: uuid, keyResultId: uuid, source: z.string(),
})

export const okrCycleSchema = resourceSchema.extend({
  workspaceId: uuid, title: z.string(), startDate: z.string(), endDate: z.string(), status: z.enum(["DRAFT", "ACTIVE", "COMPLETED"]),
})
export const objectiveSchema = resourceSchema.extend({
  workspaceId: uuid, cycleId: uuid.nullable(), squadId: uuid.nullable(), parentKeyResultId: uuid.nullable(),
  title: z.string(), description: z.string().nullable(), owner: z.string().nullable(),
  status: z.enum(["ON_TRACK", "AT_RISK", "OFF_TRACK", "COMPLETE"]), sortOrder: z.number().int(),
})
export const keyResultSchema = resourceSchema.extend({
  objectiveId: uuid, title: z.string(), target: z.number(), current: z.number(), unit: z.string().nullable(), sortOrder: z.number().int(),
})
export const checkInSchema = z.object({ id: uuid, keyResultId: uuid, value: z.number(), note: z.string().nullable(), createdAt: z.string() })
export const experimentResultSchema = z.object({ id: uuid, experimentId: uuid, note: z.string(), metric: z.string().nullable(), value: z.number().nullable(), createdAt: z.string() })
export const experimentSchema = resourceSchema.extend({
  workspaceId: uuid, squadId: uuid.nullable(), assumptionId: uuid.nullable(), title: z.string(), hypothesis: z.string(), method: z.string(),
  killCondition: z.string(), status: z.enum(["DESIGNING", "RUNNING", "COMPLETE", "KILLED", "NOT_PURSUED"]),
  startDate: z.string().nullable(), endDate: z.string().nullable(), conclusion: z.string().nullable(), conclusionReason: z.string().nullable(),
})
export const metricSchema = z.object({
  id: uuid, workspaceId: uuid, revisionId: uuid, revision: z.number().int().positive(), name: z.string(), unit: z.string(),
  provider: z.enum(["vercel", "compass_activation"]), connectionId: uuid.nullable(), query: z.record(z.string(), z.unknown()), archived: z.boolean(),
})
export const metricBindingSchema = z.object({
  id: uuid, workspaceId: uuid, metricId: uuid, revisionId: uuid, targetType: z.enum(["EXPERIMENT", "ROADMAP_ITEM", "KEY_RESULT"]),
  targetId: uuid, targetValue: z.number().nullable(), active: z.boolean(), baseline: z.unknown().nullable(), followup: z.unknown(), mode: z.string(),
  metric: metricSchema, createdAt: z.string(), updatedAt: z.string(), replacesBindingId: uuid.optional(),
})
export const metricObservationSchema = z.object({
  id: uuid, workspaceId: uuid, bindingId: uuid, kind: z.string(), windowSince: z.string(), windowUntil: z.string(),
  snapshot: z.record(z.string(), z.unknown()), data: z.record(z.string(), z.unknown()), retrievedAt: z.string(), createdAt: z.string(),
})
export const scoringMetricSchema = z.object({ key: z.string(), label: z.string(), description: z.string().nullable().optional(), minValue: z.number(), maxValue: z.number(), weight: z.number(), direction: z.enum(["POSITIVE", "NEGATIVE"]), order: z.number().int().optional() })
export const scoringModelSchema = resourceSchema.extend({
  organizationId: uuid, name: z.string(), description: z.string().nullable(), status: z.enum(["ACTIVE", "ARCHIVED"]),
  formulaType: z.enum(["WEIGHTED_SUM", "MULTIPLICATIVE"]), version: z.number().int().positive(), metrics: z.array(scoringMetricSchema),
})
export const scoreSchema = resourceSchema.extend({
  scoringModelId: uuid, modelVersion: z.number().int().positive(), formulaSnapshot: z.unknown(), rawValues: z.record(z.string(), z.number()),
  rawScore: z.number(), normalizedScore: z.number(), scoredAt: z.string(),
}).and(z.union([z.object({ opportunityId: uuid }), z.object({ solutionId: uuid })]))
export const squadSchema = resourceSchema.extend({ workspaceId: uuid, name: z.string(), description: z.string().nullable(), color: z.string().nullable() })
export const customFieldDefinitionSchema = resourceSchema.extend({
  workspaceId: uuid, objectType: z.string(), name: z.string(), fieldType: z.string(), description: z.string().nullable(),
  options: z.array(z.unknown()), required: z.boolean(), sortOrder: z.number().int(),
})
export const customFieldValueSchema = z.object({
  id: uuid, fieldId: uuid, objectType: z.string(), objectId: uuid, value: z.unknown().nullable(), createdAt: z.string(), updatedAt: z.string(),
})

export const taskLinkSchema = z.object({
  id: uuid,
  linkedType: z.enum(["OPPORTUNITY", "SOLUTION", "ROADMAP_ITEM", "OBJECTIVE", "KEY_RESULT", "DOC", "EXPERIMENT", "FEEDBACK_ITEM", "DECISION"]),
  linkedId: uuid,
  linkedTitle: z.string(),
})

export const uploadPreparationSchema = z.object({
  clientToken: z.string(),
  receipt: z.string(),
  pathname: z.string(),
  expiresAt: z.number(),
  attachmentId: uuid,
})

export const identitySchema = z.object({
  purpose: z.string(),
  userId: uuid.nullable(),
  agentId: uuid.nullable(),
  workspaces: z.array(workspaceSchema.pick({ id: true, name: true, slug: true })),
})
