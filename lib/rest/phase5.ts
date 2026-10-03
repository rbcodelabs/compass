import { z } from "zod"
import { collectionOf, uuid, workspaceSchema } from "@/lib/rest/schemas"

const timestamp = z.string().datetime()
const thinkingModel = z.object({
  key: z.string(),
  name: z.string(),
  labels: z.record(z.string(), z.object({ singular: z.string(), plural: z.string() }).strict()),
}).strict()

export const helpSearchItem = z.object({ path: z.string(), title: z.string(), excerpt: z.string() }).strict()
export const helpSearchResults = z.object({ items: z.array(helpSearchItem), nextCursor: z.null() }).strict()
export const helpTopic = z.object({
  slug: z.string(), title: z.string(), description: z.string(), icon: z.string(), order: z.number(), section: z.string(), content: z.string(),
}).strict()

export const organizationWorkspace = workspaceSchema.pick({ id: true, slug: true, name: true, description: true }).extend({
  opportunities: z.number().int().nonnegative(),
  experiments: z.number().int().nonnegative(),
  roadmapItems: z.number().int().nonnegative(),
  okrCycles: z.number().int().nonnegative(),
}).strict()
export const organizationWorkspaceCollection = collectionOf(organizationWorkspace)
export const workspaceBySlug = z.object({
  id: uuid, name: z.string(), slug: z.string(), description: z.string().nullable(), orgSlug: z.string(), thinkingModel,
}).strict()

export const workspaceSummary = z.object({
  name: z.string(),
  thinkingModel,
  activeOkrCycle: z.object({ id: uuid, title: z.string(), startDate: timestamp, endDate: timestamp }).strict().nullable(),
  opportunityCount: z.number().int().nonnegative(),
  experimentCount: z.number().int().nonnegative(),
  activeExperiments: z.number().int().nonnegative(),
  roadmapItemCount: z.number().int().nonnegative(),
  okrCycleCount: z.number().int().nonnegative(),
  squads: z.array(z.object({ id: uuid, name: z.string(), color: z.string() }).strict()),
}).strict()

const evidenceParent = z.object({ type: z.enum(["opportunity", "solution", "assumption"]), id: uuid }).strict()
const evidenceResearchSource = z.object({ researchTurnId: uuid, studyId: uuid.nullable(), sessionId: uuid.nullable(), sequence: z.number().int().nullable(), role: z.string().nullable(), resolved: z.boolean() }).strict()
export const evidence = z.object({
  id: uuid, sourceType: z.enum(["interview", "feedback", "support_ticket", "experiment_result", "analytics"]),
  excerpt: z.string(), confidence: z.enum(["high", "medium", "low"]), sourceUrl: z.string().url().nullable(), parent: evidenceParent,
  research: z.object({ researchSynthesisId: uuid, sources: z.array(evidenceResearchSource) }).strict().optional(),
}).strict()
export const evidenceCollection = collectionOf(evidence)

export const feedbackAttachment = z.object({
  id: uuid, feedbackItemId: uuid, url: z.string().url(), filename: z.string(), fileType: z.string(), fileSize: z.number().int().positive(),
  feedbackUrl: z.string().url().nullable(), alreadyAttached: z.boolean(), createdAt: timestamp, updatedAt: timestamp,
}).strict()

export const scoringAssignment = z.object({
  workspaceId: uuid, entityType: z.enum(["OPPORTUNITY", "SOLUTION"]), scoringModelId: uuid.nullable(),
}).strict()

export const checklistTemplate = z.object({
  id: uuid, name: z.string(), tier: z.enum(["TIER_1", "TIER_2", "TIER_3"]), status: z.string().optional(),
  description: z.string().nullable().optional(), itemCount: z.number().int().nonnegative().optional(),
  items: z.array(z.object({ label: z.string(), description: z.string().nullable().optional(), order: z.number().int() }).strict()).optional(),
}).strict()
export const checklistTemplateCollection = collectionOf(checklistTemplate)

export const eligibleParentKeyResult = z.object({ id: uuid, cycleTitle: z.string(), objectiveTitle: z.string(), title: z.string() }).strict()
export const eligibleParentKeyResultCollection = collectionOf(eligibleParentKeyResult)

export const taskAssignee = z.object({
  type: z.enum(["USER", "AGENT"]), id: uuid, displayName: z.string(), ownerName: z.string().nullable().optional(),
}).strict()
export const taskAssigneeCollection = collectionOf(taskAssignee)

export const taskLink = z.object({
  id: uuid, linkedType: z.string(), linkedId: uuid, linkedTitle: z.string(),
}).strict()
export const taskLinkCollection = collectionOf(taskLink)

export const feedbackSource = z.object({
  sourceId: uuid, name: z.string().optional(), enabled: z.boolean().optional(), authMode: z.enum(["INTERNAL_SSO", "PORTAL"]),
  allowedOrigins: z.array(z.string()), tokenPrefix: z.string().optional(), snippet: z.string().nullable().optional(),
  scriptPath: z.string().optional(), scriptUrl: z.string().url().nullable().optional(), note: z.string().nullable().optional(),
}).strict()
export const feedbackSourceCredential = feedbackSource.extend({ token: z.string().min(1) }).strict()

export const opportunityRanking = z.object({
  opportunityId: uuid, title: z.string(), status: z.string(), normalizedScore: z.number(), workspace: z.string(),
}).strict()
export const opportunityRankingCollection = collectionOf(opportunityRanking)
