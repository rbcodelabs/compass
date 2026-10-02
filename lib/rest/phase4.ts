import { z } from "zod"
import { synthesisSchema } from "@/lib/research-analysis"
import { PM_INTERVIEW_TARGET_TYPES, pmInterviewContextSchema } from "@/lib/pm-interview-contracts"
import { CARD_SORT_NEW_ENTRY_STATUSES } from "@/lib/card-sort-new-entries"
import { CARD_SORT_ROUND_STATES } from "@/lib/card-sort"
import { collectionOf, cursorQuery, uuid } from "@/lib/rest/schemas"

const timestamp = z.string().datetime()
const nullableTimestamp = timestamp.nullable()
const option = z.object({ label: z.string(), value: z.string() }).strict()
const cardSortObjectType = z.enum(["OPPORTUNITY", "SOLUTION", "EXPERIMENT", "OBJECTIVE", "KEY_RESULT", "ROADMAP_ITEM", "TASK"])

const researchGuide = z.array(z.union([z.string(), z.object({ id: z.string(), text: z.string() }).strict()])).max(20)
export const researchStudyInput = z.object({
  name: z.string().trim().min(1).max(255), goal: z.string().trim().min(1).max(5_000), guide: z.array(z.string().trim().min(1).max(1_000)).min(1).max(20),
  studyType: z.enum(["CUSTOMER_INTERVIEW", "USABILITY_TEST"]).optional(), targetMinutes: z.union([z.literal(10), z.literal(15), z.literal(20), z.literal(30)]).optional(),
  appUrl: z.string().max(2_048).optional(), artifactId: uuid.optional(),
}).strict()
export const researchStudyPatch = researchStudyInput.partial().extend({ name: researchStudyInput.shape.name }).strict()
export const researchStudy = z.object({
  id: uuid, workspaceId: uuid, name: z.string(), goal: z.string(), studyType: z.enum(["CUSTOMER_INTERVIEW", "USABILITY_TEST"]), guide: researchGuide,
  targetMinutes: z.number().int(), appUrl: z.string().nullable(), artifactId: uuid.nullable(), status: z.enum(["DRAFT", "ACTIVE", "CLOSED", "ARCHIVED"]),
  createdAt: timestamp, updatedAt: timestamp, sessionCount: z.number().int().nonnegative(),
}).strict()
export const researchStudyCollection = collectionOf(researchStudy)
export const researchStudyQuery = cursorQuery.extend({ status: researchStudy.shape.status.optional() }).strict()
export const participantLink = z.object({ id: uuid, status: researchStudy.shape.status.optional(), participantUrl: z.string().url().nullable() }).strict()
export const researchSession = z.object({
  id: uuid, studyId: uuid, modality: z.enum(["CHAT", "VOICE"]), status: z.string(), startedAt: nullableTimestamp, completedAt: nullableTimestamp,
  lastActiveAt: nullableTimestamp, endedReason: z.string().nullable(), createdAt: timestamp, turnCount: z.number().int().nonnegative(), hasSummary: z.boolean(),
}).strict()
export const researchTurn = z.object({ id: uuid, role: z.enum(["PARTICIPANT", "INTERVIEWER"]), content: z.string(), sequence: z.number().int() }).strict()
export const researchSessionDetail = researchSession.extend({ turns: z.array(researchTurn), nextCursor: z.string().nullable() }).strict()
export const synthesisContent = synthesisSchema
export const researchSynthesis = z.object({ id: uuid, sessionCount: z.number().int().nonnegative(), createdAt: timestamp, content: synthesisContent.nullable() }).strict()
export const evidencePromotionInput = z.object({ findingIndex: z.number().int().min(0).max(9), opportunityId: uuid.optional(), solutionId: uuid.optional(), assumptionId: uuid.optional(), confidence: z.enum(["high", "medium", "low"]).optional() }).strict()
export const evidencePromotion = z.object({ id: uuid, findingKey: z.string(), researchSynthesisId: uuid, sourceTurnIds: z.array(uuid), opportunityId: uuid.nullable(), solutionId: uuid.nullable(), assumptionId: uuid.nullable(), replayed: z.boolean() }).strict()

const pmTurn = researchTurn.extend({ createdAt: timestamp }).strict()
const pmProposalField = z.object({ value: z.string().nullable(), transcriptTurnIds: z.array(uuid).max(50) }).strict()
const pmProposalBase = {
  version: z.literal(1), brief: z.string(), openQuestions: z.array(z.string()), suggestedNextSteps: z.array(z.string()), unknowns: z.array(z.string()),
}
const pmProposal = z.union([
  z.object({ ...pmProposalBase, proposedFields: z.object({ title: pmProposalField.optional(), description: pmProposalField.optional(), customerSegment: pmProposalField.optional() }).strict() }).strict(),
  z.object({ ...pmProposalBase, proposedFields: z.object({ title: pmProposalField.optional(), description: pmProposalField.optional() }).strict() }).strict(),
  z.object({ ...pmProposalBase, proposedFields: z.object({ title: pmProposalField.optional(), hypothesis: pmProposalField.optional(), method: pmProposalField.optional(), killCondition: pmProposalField.optional() }).strict() }).strict(),
])
const pmReceipt = z.union([
  z.object({ version: z.literal(1), kind: z.literal("DISMISSED"), at: timestamp }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("APPLIED"), selectedFields: z.array(z.string()), before: z.record(z.string(), z.string().nullable()), after: z.record(z.string(), z.string().nullable()), at: timestamp }).strict(),
])
export const pmInterview = z.object({
  version: z.literal(1), id: uuid, agentConversationId: uuid.nullable(), targetType: z.enum(PM_INTERVIEW_TARGET_TYPES), targetId: uuid,
  generationState: z.string(), generationFailureCode: z.string().nullable(), disposition: z.string(), createdAt: timestamp, updatedAt: timestamp,
  owner: z.boolean(), context: pmInterviewContextSchema, reviewBaseline: z.object({ version: z.literal(1), fields: z.record(z.string(), z.string().nullable()) }).strict(),
  proposal: pmProposal.nullable(), receipt: pmReceipt.nullable(), session: z.object({ id: uuid, status: z.string(), modality: z.string(), turns: z.array(pmTurn) }).strict(),
  applicationDisabledReason: z.string().nullable(),
}).strict()

export const analyticsConnection = z.object({ id: uuid, provider: z.string(), projectId: z.string(), teamId: z.string().nullable(), enabled: z.boolean(), health: z.string(), generation: z.number().int().positive() }).strict()
export const analyticsConnectionInput = z.object({ provider: z.literal("vercel"), projectId: z.string().trim().min(1).max(255), teamId: z.string().trim().min(1).max(255).optional(), token: z.string().trim().min(1).max(4096) }).strict()

export const cardSortFactor = z.object({ id: uuid, name: z.string(), objectType: cardSortObjectType, options: z.array(option), sharedOptionSetName: z.string().nullable() }).strict()
export const cardSortRound = z.object({ id: uuid, name: z.string(), objectType: cardSortObjectType, fieldDefinitionId: uuid, factorName: z.string(), state: z.enum(CARD_SORT_ROUND_STATES), createdById: uuid, createdAt: timestamp, revealedAt: nullableTimestamp, closedAt: nullableTimestamp, proposalCount: z.number().int().nonnegative().nullable(), myProposalCount: z.number().int().nonnegative() }).strict()
export const cardSortProposal = z.object({ objectId: uuid, objectTitle: z.string(), proposedValue: z.string(), fromValue: z.string().nullable(), rationale: z.string().nullable(), updatedAt: timestamp }).strict()
export const cardSortProposalResult = z.object({ applied: z.array(uuid), skipped: z.array(z.object({ objectId: uuid, code: z.enum(["NOT_FOUND", "INVALID_FACTOR", "WRONG_STATE", "INVALID_VALUE", "NO_OP", "HIDDEN_UNTIL_REVEAL", "FORBIDDEN"]), reason: z.string() }).strict()) }).strict()
const boardProposal = z.object({ objectId: uuid, userId: uuid, userName: z.string(), proposedValue: z.string(), fromValue: z.string().nullable(), rationale: z.string().nullable(), isMine: z.boolean() }).strict()
export const cardSortBoard = z.object({ round: cardSortRound, factor: z.object({ id: uuid, name: z.string(), options: z.array(option) }).strict(), rows: z.array(z.object({ objectId: uuid, title: z.string(), currentValue: z.string().nullable(), myProposedValue: z.string().nullable(), myRationale: z.string().nullable() }).strict()), proposals: z.array(boardProposal), isFacilitator: z.boolean(), canSeeTally: z.boolean() }).strict()
const tallyObject = z.object({
  objectId: uuid, title: z.string(), currentValue: z.string().nullable(),
  targets: z.array(z.object({ value: z.string(), count: z.number().int().nonnegative(), proposers: z.array(z.object({ userId: uuid, userName: z.string(), rationale: z.string().nullable() }).strict()) }).strict()),
  proposalCount: z.number().int().nonnegative(), distinctTargetCount: z.number().int().nonnegative(), unanimousMove: z.boolean(),
}).strict()
const tallyFlow = z.object({
  edges: z.array(z.object({ from: z.string().nullable(), to: z.string(), count: z.number().int().nonnegative() }).strict()),
  buckets: z.array(z.object({ value: z.string(), inflow: z.number().int().nonnegative(), outflow: z.number().int().nonnegative(), net: z.number().int() }).strict()),
  fromUnsetCount: z.number().int().nonnegative(),
}).strict()
export const cardSortTally = z.object({ round: z.object({ id: uuid, name: z.string(), state: z.enum(CARD_SORT_ROUND_STATES), factorName: z.string() }).strict(), options: z.array(option), objects: z.array(tallyObject), contested: z.array(tallyObject), flow: tallyFlow, participantCount: z.number().int().nonnegative(), proposalCount: z.number().int().nonnegative() }).strict()
export const cardSortNewEntry = z.object({ id: uuid, userId: uuid, userName: z.string(), title: z.string(), description: z.string().nullable(), suggestedValue: z.string().nullable(), status: z.enum(CARD_SORT_NEW_ENTRY_STATUSES), acceptedObjectId: uuid.nullable(), resolutionNote: z.string().nullable(), resolvedAt: nullableTimestamp, createdAt: timestamp, isMine: z.boolean() }).strict()
export const cardSortAcceptance = z.object({ entryId: uuid, opportunityId: uuid, suggestionRecorded: z.boolean() }).strict()
