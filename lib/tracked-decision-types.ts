// Pure constants/types for tracked decisions — deliberately free of any
// server-only imports (Prisma, `@/lib/db`, node builtins). `lib/tracked-decisions.ts`
// re-exports these for server code, but client components (e.g. the Decisions
// filters) must import from *this* module directly: pulling them in from
// `lib/tracked-decisions.ts` drags `pg`/`getPrisma` into the client bundle
// and breaks compilation (`Can't resolve 'fs'/'net'/'tls'`).
export const TRACKED_SUBJECT_TYPES = ["WORKSPACE", "OPPORTUNITY", "SOLUTION", "ROADMAP_ITEM", "DOC", "EXPERIMENT", "FEEDBACK"] as const
export type TrackedSubjectType = (typeof TRACKED_SUBJECT_TYPES)[number]
export const TRACKED_SUBJECT_LABELS: Record<TrackedSubjectType, string> = { WORKSPACE: "Workspace", OPPORTUNITY: "Opportunity", SOLUTION: "Solution", ROADMAP_ITEM: "Roadmap Item", DOC: "Doc", EXPERIMENT: "Experiment", FEEDBACK: "Feedback" }
export const TRACKED_SOURCE_TYPES = ["WORKSPACE", "OPPORTUNITY", "SOLUTION", "ASSUMPTION", "ROADMAP_ITEM", "DOC", "EXPERIMENT", "FEEDBACK", "EVIDENCE"] as const
export type TrackedSourceType = (typeof TRACKED_SOURCE_TYPES)[number]

// Caller-supplied choices on a tracked decision (the "question with options"
// pattern). Each becomes an APPROVE-class ReviewOption keyed CHOICE_1..n; the
// standard Request changes / Reject rows are always appended after them.
export const TRACKED_OPTION_LIMITS = { min: 2, max: 4, labelMax: 120, descriptionMax: 500 } as const
export type TrackedDecisionOptionInput = { label: string; description?: string | null }
/** The normalized shape stored in the packet: trimmed, description omitted when empty. */
export type TrackedDecisionPacketOption = { label: string; description?: string }
export const CHOICE_ACTION_KEY_PREFIX = "CHOICE_"
export function isChoiceActionKey(actionKey: string | null | undefined): boolean { return Boolean(actionKey?.startsWith(CHOICE_ACTION_KEY_PREFIX)) }
