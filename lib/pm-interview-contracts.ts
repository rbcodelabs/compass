import { z } from "zod"
import { createHash } from "node:crypto"

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
const titleFieldValue = z.string().trim().min(1).max(255)
const customerSegmentFieldValue = z.string().trim().max(255).nullable().transform(value => value || null)
const requiredTextFieldValue = z.string().max(20_000)
const pmInterviewFieldSchemas = {
  OPPORTUNITY: { title: titleFieldValue, description: nullableFieldValue, customerSegment: customerSegmentFieldValue },
  SOLUTION: { title: titleFieldValue, description: nullableFieldValue },
  ASSUMPTION: { title: titleFieldValue, description: nullableFieldValue },
  EXPERIMENT: { title: titleFieldValue, hypothesis: requiredTextFieldValue, method: requiredTextFieldValue, killCondition: requiredTextFieldValue },
} as const

export function normalizePmInterviewFieldValue(targetType: PmInterviewTargetType, field: string, value: unknown): string | null {
  if (!(field in pmInterviewFieldSchemas[targetType])) throw new Error("A selected field is not editable")
  return (pmInterviewFieldSchemas[targetType] as Record<string, z.ZodType<string | null>>)[field].parse(value)
}

export function parsePmInterviewBaseline(value: string, targetType: PmInterviewTargetType) {
  const fields = pmInterviewFieldSchemas[targetType]
  return z.object({ version: z.literal(1), fields: z.object(fields).strict() }).strict().parse(JSON.parse(value))
}

const proposalField = (value: z.ZodType<string | null>) => z.object({
  value,
  transcriptTurnIds: z.array(z.string().uuid()).max(50),
}).strict()

export function parsePmInterviewProposal(value: string, targetType: PmInterviewTargetType) {
  const proposedFields = Object.fromEntries(PM_INTERVIEW_ALLOWED_FIELDS[targetType].map((field) => [field, proposalField((pmInterviewFieldSchemas[targetType] as Record<string, z.ZodType<string | null>>)[field]).optional()]))
  return z.object({
    version: z.literal(1),
    brief: z.string().min(1).max(20_000),
    proposedFields: z.object(proposedFields).strict(),
    openQuestions: z.array(z.string().min(1).max(2_000)).max(20),
    suggestedNextSteps: z.array(z.string().min(1).max(2_000)).max(20),
    unknowns: z.array(z.string().min(1).max(2_000)).max(20),
  }).strict().parse(JSON.parse(value))
}

export function resolvePmInterviewApplyInput(
  targetType: PmInterviewTargetType,
  proposal: ReturnType<typeof parsePmInterviewProposal>,
  input: { selectedFields: unknown; editedValues?: unknown },
) {
  const allowed = PM_INTERVIEW_ALLOWED_FIELDS[targetType] as readonly string[]
  if (!Array.isArray(input.selectedFields) || input.selectedFields.length === 0) throw new Error("Select at least one field")
  if (input.selectedFields.length > allowed.length || input.selectedFields.some(field => typeof field !== "string") || new Set(input.selectedFields).size !== input.selectedFields.length) throw new Error("Select valid fields to apply")
  const selectedFields = input.selectedFields as string[]
  if (selectedFields.some(field => !allowed.includes(field))) throw new Error("A selected field is not editable")
  if (input.editedValues !== undefined && (!input.editedValues || typeof input.editedValues !== "object" || Array.isArray(input.editedValues))) throw new Error("Edited values are invalid")
  const editedValues = (input.editedValues ?? {}) as Record<string, unknown>
  if (Object.keys(editedValues).some(field => !allowed.includes(field))) throw new Error("Edited values contain a field that is not editable")

  const values: Record<string, string | null> = {}
  for (const field of [...selectedFields].sort()) {
    const generated = proposal.proposedFields[field as keyof typeof proposal.proposedFields]
    const value = field in editedValues ? editedValues[field] : generated?.value
    if (value === undefined) throw new Error(`No proposed value for ${field}`)
    values[field] = normalizePmInterviewFieldValue(targetType, field, value)
  }
  const requestFingerprint = createHash("sha256").update(JSON.stringify({ selectedFields: Object.keys(values), values })).digest("hex")
  return { selectedFields: Object.keys(values), values, requestFingerprint }
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

type PmInterviewReadSource = {
  id: string
  targetType: string
  targetId: string
  initiatingUserId: string
  contextSnapshotJson: string
  fieldBaselineJson: string
  proposalJson: string | null
  generationState: string
  generationFailureCode: string | null
  disposition: string
  createdAt: Date
  updatedAt: Date
  session: {
    id: string
    status: string
    modality: string
    turns: Array<{ id: string; role: string; content: string; sequence: number; createdAt: Date }>
  }
}

export function buildPmInterviewReadDto(source: PmInterviewReadSource, actorUserId: string) {
  const targetType = parsePmInterviewTargetType(source.targetType)
  return {
    version: 1 as const,
    id: source.id,
    targetType,
    targetId: source.targetId,
    generationState: source.generationState,
    generationFailureCode: source.generationFailureCode,
    disposition: source.disposition,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    owner: source.initiatingUserId === actorUserId,
    context: pmInterviewContextSchema.parse(JSON.parse(source.contextSnapshotJson)),
    reviewBaseline: parsePmInterviewBaseline(source.fieldBaselineJson, targetType),
    proposal: source.proposalJson ? parsePmInterviewProposal(source.proposalJson, targetType) : null,
    session: {
      id: source.session.id,
      status: source.session.status,
      modality: source.session.modality,
      turns: source.session.turns.map(({ id, role, content, sequence, createdAt }) => ({ id, role, content, sequence, createdAt })),
    },
  }
}
