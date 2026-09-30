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
/** Lower-cased labels a custom option may not reuse: Request changes / Reject are always appended after the choices. */
export const RESERVED_OPTION_LABELS: ReadonlySet<string> = new Set(["request changes", "reject"])
export const CHOICE_ACTION_KEY_PREFIX = "CHOICE_"
export function isChoiceActionKey(actionKey: string | null | undefined): boolean { return Boolean(actionKey?.startsWith(CHOICE_ACTION_KEY_PREFIX)) }

// Multi-question requests: one tracked decision carrying 1-4 questions, each
// with its own single-choice options. The questions live in the immutable
// packet; the reviewer's per-question answers live in
// decision_records.answers_json. The revision's ReviewOptions are then
// Submit answers (APPROVE) / Request changes / Reject, so Request changes and
// Reject apply to the whole request and need no answers.
export const TRACKED_QUESTION_LIMITS = { min: 1, max: 4, headerMax: 40, questionMax: 255 } as const
export type TrackedDecisionQuestionInput = { header?: string | null; question: string; options: TrackedDecisionOptionInput[] }
/** The normalized shape stored in the packet: trimmed, header omitted when empty. */
export type TrackedDecisionPacketQuestion = { header?: string; question: string; options: TrackedDecisionPacketOption[] }
/** A reviewer's answer to one question, as submitted (the option label chosen). */
export type TrackedDecisionAnswerInput = { questionIndex: number; chosenOption: string }
/** An answer as persisted and read back, with the question text snapshotted. */
export type TrackedDecisionAnswer = { questionIndex: number; question: string; chosenOption: string }
export const SUBMIT_ANSWERS_ACTION_KEY = "SUBMIT_ANSWERS"
export function isSubmitAnswersActionKey(actionKey: string | null | undefined): boolean { return actionKey === SUBMIT_ANSWERS_ACTION_KEY }

/** Questions carried by a stored packet; [] for option-less and single-options packets, or an unreadable one. */
export function parsePacketQuestions(packetJson: string | null | undefined): TrackedDecisionPacketQuestion[] {
  if (!packetJson) return []
  try {
    const questions = (JSON.parse(packetJson) as { questions?: unknown }).questions
    return Array.isArray(questions) ? (questions as TrackedDecisionPacketQuestion[]) : []
  } catch { return [] }
}

/** Answers persisted on a decision record; [] when none were recorded or the value is unreadable. */
export function parseDecisionAnswers(answersJson: string | null | undefined): TrackedDecisionAnswer[] {
  if (!answersJson) return []
  try {
    const answers = JSON.parse(answersJson) as unknown
    return Array.isArray(answers) ? (answers as TrackedDecisionAnswer[]) : []
  } catch { return [] }
}
