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

const nullableFieldValue = z.string().trim().max(20_000).nullable().transform(value => value || null)
const titleFieldValue = z.string().trim().min(1).max(255)
const customerSegmentFieldValue = z.string().trim().max(255).nullable().transform(value => value || null)
const requiredTextFieldValue = z.string().trim().min(1).max(20_000)
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

export function parsePmInterviewBaseline(value: string, targetType: PmInterviewTargetType): { version: 1; fields: Record<string, string | null> } {
  const storedText = z.string().max(1_000_000)
  const fields = targetType === "OPPORTUNITY"
    ? { title: z.string().max(255), description: storedText.nullable(), customerSegment: z.string().max(255).nullable() }
    : targetType === "SOLUTION" || targetType === "ASSUMPTION"
      ? { title: z.string().max(255), description: storedText.nullable() }
      : { title: z.string().max(255), hypothesis: storedText, method: storedText, killCondition: storedText }
  return z.object({ version: z.literal(1), fields: z.object(fields).strict() }).strict().parse(JSON.parse(value)) as { version: 1; fields: Record<string, string | null> }
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

export const pmInterviewContextIntakeSchema = pmInterviewContextSchema.extend({
  target: pmInterviewContextSchema.shape.target.extend({
    fields: z.record(z.string(), z.string().max(1_000_000).nullable()),
  }).strict(),
}).strict()

export type PmInterviewContextSnapshot = z.infer<typeof pmInterviewContextSchema>

const pmVoiceSettlementSchema = z.object({
  version: z.literal(1),
  phase: z.literal("SETTLED"),
  leaseId: z.string().uuid(),
  settlement: z.enum(["FINALIZED", "DISCARD_PENDING"]),
  finalizedEventCount: z.number().int().nonnegative(),
  lastFinalizedOrdinal: z.number().int().nonnegative().nullable(),
  at: z.string().datetime(),
}).strict()

const pmVoiceTransitionSchema = pmVoiceSettlementSchema.extend({ phase: z.literal("TRANSITIONED") }).strict()
const pmVoiceSpeechPendingSchema = z.object({
  version: z.literal(1),
  phase: z.literal("SPEECH_PENDING"),
  leaseId: z.string().uuid(),
  speechId: z.string().regex(/^(?:input|output):[A-Za-z0-9_.:-]{1,255}$/),
  at: z.string().datetime(),
}).strict()

export type PmInterviewVoiceTransitionReceipt = z.infer<typeof pmVoiceSettlementSchema> | z.infer<typeof pmVoiceTransitionSchema> | z.infer<typeof pmVoiceSpeechPendingSchema>

export function parsePmInterviewVoiceTransitionReceipt(value: string | null): PmInterviewVoiceTransitionReceipt | null {
  if (!value) return null
  return z.discriminatedUnion("phase", [pmVoiceSettlementSchema, pmVoiceTransitionSchema, pmVoiceSpeechPendingSchema]).parse(JSON.parse(value))
}

type PmInterviewReadSource = {
  agentConversationId?: string | null
  id: string
  targetType: string
  targetId: string
  initiatingUserId: string
  contextSnapshotJson: string
  fieldBaselineJson: string
  proposalJson: string | null
  receiptJson: string | null
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

const appliedReceiptSchema = z.object({
  version: z.literal(1),
  kind: z.literal("APPLIED"),
  idempotencyKey: z.string().min(1).max(128),
  requestFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  actorUserId: z.string().uuid(),
  selectedFields: z.array(z.string()).min(1).max(4),
  before: z.record(z.string(), z.string().nullable()),
  after: z.record(z.string(), z.string().nullable()),
  at: z.string().datetime(),
}).strict()

const dismissedReceiptSchema = z.object({
  version: z.literal(1),
  kind: z.literal("DISMISSED"),
  idempotencyKey: z.string().min(1).max(128),
  actorUserId: z.string().uuid(),
  at: z.string().datetime(),
}).strict()

export function parsePmInterviewSafeReceipt(value: string | null, targetType: PmInterviewTargetType) {
  if (!value) return null
  const parsed = z.discriminatedUnion("kind", [appliedReceiptSchema, dismissedReceiptSchema]).parse(JSON.parse(value))
  if (parsed.kind === "DISMISSED") return { version: 1 as const, kind: "DISMISSED" as const, at: parsed.at }
  const allowed = new Set<string>(PM_INTERVIEW_ALLOWED_FIELDS[targetType])
  const selected = new Set(parsed.selectedFields)
  if (selected.size !== parsed.selectedFields.length || parsed.selectedFields.some(field => !allowed.has(field)) ||
    Object.keys(parsed.before).some(field => !selected.has(field)) || Object.keys(parsed.after).some(field => !selected.has(field)) ||
    Object.keys(parsed.before).length !== selected.size || Object.keys(parsed.after).length !== selected.size) throw new Error("Stored PM interview receipt contains unsafe fields")
  return { version: 1 as const, kind: "APPLIED" as const, selectedFields: parsed.selectedFields, before: parsed.before, after: parsed.after, at: parsed.at }
}

export function buildPmInterviewReadDto(source: PmInterviewReadSource, actorUserId: string) {
  const targetType = parsePmInterviewTargetType(source.targetType)
  return {
    version: 1 as const,
    id: source.id,
    agentConversationId: source.initiatingUserId === actorUserId ? source.agentConversationId ?? null : null,
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
    receipt: parsePmInterviewSafeReceipt(source.receiptJson, targetType),
    session: {
      id: source.session.id,
      status: source.session.status,
      modality: source.session.modality,
      turns: source.session.turns.map(({ id, role, content, sequence, createdAt }) => ({ id, role, content, sequence, createdAt })),
    },
  }
}
