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
