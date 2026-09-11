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
    if (value !== null && (typeof value !== "string" || value.length > 20_000)) throw new Error(`${field} is too long`)
    if (field === "title" && (!value || value.length > 255)) throw new Error("Title is required and must be 255 characters or fewer")
    values[field] = value
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
