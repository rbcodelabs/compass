import { z } from "zod"

export const PM_INTERVIEW_TARGET_TYPES = ["OPPORTUNITY", "SOLUTION", "ASSUMPTION", "EXPERIMENT"] as const
export type PmInterviewTargetType = (typeof PM_INTERVIEW_TARGET_TYPES)[number]

export const PM_INTERVIEW_ALLOWED_FIELDS = {
  OPPORTUNITY: ["title", "description", "customerSegment"],
  SOLUTION: ["title", "description"],
  ASSUMPTION: ["title", "description"],
  EXPERIMENT: ["title", "hypothesis", "method", "killCondition"],
} as const satisfies Record<PmInterviewTargetType, readonly string[]>

export function parsePmInterviewTargetType(value: unknown): PmInterviewTargetType {
  const parsed = z.enum(PM_INTERVIEW_TARGET_TYPES).safeParse(value)
  if (!parsed.success) throw new Error("Unsupported PM interview target")
  return parsed.data
}

const nullableFieldValue = z.string().max(20_000).nullable()

export function parsePmInterviewBaseline(value: string, targetType: PmInterviewTargetType) {
  const fields = Object.fromEntries(PM_INTERVIEW_ALLOWED_FIELDS[targetType].map((field) => [field, nullableFieldValue]))
  return z.object({ version: z.literal(1), fields: z.object(fields).strict() }).strict().parse(JSON.parse(value))
}

const proposalField = z.object({
  value: nullableFieldValue,
  transcriptTurnIds: z.array(z.string().uuid()).max(50),
}).strict()

export function parsePmInterviewProposal(value: string, targetType: PmInterviewTargetType) {
  const proposedFields = Object.fromEntries(PM_INTERVIEW_ALLOWED_FIELDS[targetType].map((field) => [field, proposalField.optional()]))
  return z.object({
    version: z.literal(1),
    brief: z.string().min(1).max(20_000),
    proposedFields: z.object(proposedFields).strict(),
    openQuestions: z.array(z.string().min(1).max(2_000)).max(20),
    suggestedNextSteps: z.array(z.string().min(1).max(2_000)).max(20),
    unknowns: z.array(z.string().min(1).max(2_000)).max(20),
  }).strict().parse(JSON.parse(value))
}

export const pmInterviewContextSchema = z.object({
  version: z.literal(1),
  capturedAt: z.string().datetime(),
  target: z.object({ type: z.enum(PM_INTERVIEW_TARGET_TYPES), id: z.string().uuid(), fields: z.record(z.string(), nullableFieldValue) }).strict(),
  parents: z.array(z.object({ type: z.string(), id: z.string().uuid(), title: z.string() }).strict()).max(4),
  outcome: z.object({ id: z.string().uuid(), title: z.string() }).strict().nullable(),
  evidence: z.array(z.object({ id: z.string().uuid(), excerpt: z.string().max(1_000) }).strict()).max(20),
  feedback: z.array(z.object({ id: z.string().uuid(), excerpt: z.string().max(1_000) }).strict()).max(20),
  omissions: z.array(z.string().max(500)).max(20),
}).strict()

export type PmInterviewContextSnapshot = z.infer<typeof pmInterviewContextSchema>
