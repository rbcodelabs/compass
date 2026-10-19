/**
 * Human-readable work item IDs (ADR "Human-readable work item IDs"): `OPP-42`,
 * `TASK-113`. One counter per (workspace, type); the UUID stays the primary key.
 *
 * This module is the pure half: the prefix registry, `format`, `parse` and
 * `classifyWorkItemRef` (UUID versus display ID). It is deliberately
 * dependency-free (no Prisma, no `next/*`) like lib/entity-links.ts, so client
 * components can import it. Allocation lives in lib/work-item-sequence.ts and the
 * database lookup that turns a display ID into a row comes with the resolution
 * pass; both build on the registry here.
 */

export const WORK_ITEM_TYPES = [
  "objective",
  "keyResult",
  "opportunity",
  "solution",
  "assumption",
  "experiment",
  "task",
  "roadmapItem",
  "feedback",
  "reviewRequest",
  "doc",
  "artifact",
  "researchStudy",
  "metric",
] as const

export type WorkItemType = (typeof WORK_ITEM_TYPES)[number]

export type WorkItemTypeInfo = {
  /** Stored in `seq_prefix` and shown to people. Upper case, letters only. */
  prefix: string
  /** Database table that carries `seq_prefix` / `seq_number`. */
  table: string
  /** Human label, used in "TASK-5 is a Task" mismatch errors. */
  label: string
}

/**
 * Prefix per type. Invariants (asserted in __tests__/work-item-ids.test.ts):
 * unique, <= 8 characters (the `seq_prefix` column width), letters only, and no
 * prefix is a prefix of another, so a display ID is never ambiguous.
 */
export const WORK_ITEM_REGISTRY = {
  objective: { prefix: "OBJ", table: "objectives", label: "Objective" },
  keyResult: { prefix: "KR", table: "key_results", label: "Key Result" },
  opportunity: { prefix: "OPP", table: "opportunities", label: "Opportunity" },
  solution: { prefix: "SOL", table: "solutions", label: "Solution" },
  assumption: { prefix: "ASM", table: "assumptions", label: "Assumption" },
  experiment: { prefix: "EXP", table: "experiments", label: "Experiment" },
  task: { prefix: "TASK", table: "tasks", label: "Task" },
  roadmapItem: { prefix: "RM", table: "roadmap_items", label: "Roadmap Item" },
  feedback: { prefix: "FB", table: "feedback", label: "Feedback" },
  // The ID lives on the request: one request can have several decision cycles,
  // so `DEC-n` resolves to the ReviewRequest and DecisionRecord gets no ID.
  reviewRequest: { prefix: "DEC", table: "review_requests", label: "Decision" },
  doc: { prefix: "DOC", table: "docs", label: "Doc" },
  artifact: { prefix: "ART", table: "artifacts", label: "Artifact" },
  researchStudy: { prefix: "STUDY", table: "research_studies", label: "Research Study" },
  metric: { prefix: "MET", table: "metric_definitions", label: "Metric" },
} as const satisfies Record<WorkItemType, WorkItemTypeInfo>

export const SEQ_PREFIX_MAX_LENGTH = 8

/** `seq_number` is a 32-bit INT column. */
export const SEQ_NUMBER_MAX = 2_147_483_647

const TYPE_BY_PREFIX: ReadonlyMap<string, WorkItemType> = new Map(
  WORK_ITEM_TYPES.map((type) => [WORK_ITEM_REGISTRY[type].prefix, type]),
)

const DISPLAY_ID_PATTERN = /^([A-Za-z]+)-(\d+)$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ParsedDisplayId = {
  type: WorkItemType
  prefix: string
  number: number
}

export function isWorkItemType(value: unknown): value is WorkItemType {
  return typeof value === "string" && Object.hasOwn(WORK_ITEM_REGISTRY, value)
}

export function workItemPrefix(type: WorkItemType): string {
  return WORK_ITEM_REGISTRY[type].prefix
}

export function workItemTypeForPrefix(prefix: string): WorkItemType | null {
  return TYPE_BY_PREFIX.get(prefix.toUpperCase()) ?? null
}

/** `formatDisplayId("task", 113)` is `"TASK-113"`. Throws on a number the column cannot hold. */
export function formatDisplayId(type: WorkItemType, seqNumber: number): string {
  if (!Number.isSafeInteger(seqNumber) || seqNumber < 1 || seqNumber > SEQ_NUMBER_MAX) {
    throw new RangeError(`Work item number out of range: ${seqNumber}`)
  }
  return `${WORK_ITEM_REGISTRY[type].prefix}-${seqNumber}`
}

/**
 * Display ID for a row that may not be numbered yet (`seq_*` are nullable until
 * the backfill finishes). Returns null so the caller can fall back to a short UUID.
 */
export function displayIdFromRow(
  type: WorkItemType,
  row: { seqPrefix?: string | null; seqNumber?: number | null },
): string | null {
  if (row.seqNumber == null || row.seqNumber < 1) return null
  const prefix = row.seqPrefix ?? WORK_ITEM_REGISTRY[type].prefix
  return `${prefix}-${row.seqNumber}`
}

/**
 * Parses a display ID. Case-insensitive, tolerates leading zeros (`opp-007`),
 * rejects unknown prefixes, zero, and numbers beyond the INT column. Never throws.
 */
export function parseDisplayId(input: string): ParsedDisplayId | null {
  const match = DISPLAY_ID_PATTERN.exec(input.trim())
  if (!match) return null
  const type = workItemTypeForPrefix(match[1])
  if (!type) return null
  const number = Number(match[2])
  if (!Number.isSafeInteger(number) || number < 1 || number > SEQ_NUMBER_MAX) return null
  return { type, prefix: WORK_ITEM_REGISTRY[type].prefix, number }
}

export type WorkItemRef =
  | { kind: "uuid"; id: string }
  | { kind: "display"; parsed: ParsedDisplayId }
  | { kind: "invalid" }

/**
 * Resolution rule shared by pages, REST and MCP (ADR section 7): a UUID is looked
 * up by `id` exactly as today so old links never break; otherwise a display ID is
 * looked up by (workspace, prefix, number); anything else is "not found".
 */
export function classifyWorkItemRef(input: string): WorkItemRef {
  const trimmed = input.trim()
  if (UUID_PATTERN.test(trimmed)) return { kind: "uuid", id: trimmed.toLowerCase() }
  const parsed = parseDisplayId(trimmed)
  return parsed ? { kind: "display", parsed } : { kind: "invalid" }
}

/** The "TASK-5 is a Task" error for a display ID passed to the wrong entity's tool. */
export function displayIdMismatchMessage(parsed: ParsedDisplayId): string {
  return `${parsed.prefix}-${parsed.number} is a ${WORK_ITEM_REGISTRY[parsed.type].label}`
}
