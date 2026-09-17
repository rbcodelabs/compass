/**
 * Handoff domains that can drive a claimed agent turn.
 *
 * `RESEARCH_SYNTHESIS` joined at ADR-0012 step 4. Because the policy registry
 * and every dispatch site are typed as `Record<HandoffKind, ...>`, widening this
 * union turns each unhandled site into a compile error rather than a silent
 * fallthrough into PM-interview logic — that forcing function is the point.
 */
export const HANDOFF_KINDS = ["PM_INTERVIEW", "RESEARCH_SYNTHESIS"] as const
export type HandoffKind = (typeof HANDOFF_KINDS)[number]

/**
 * Carried inside the conversation's `interview_processing_json` blob. The column
 * keeps its PM-era name and is reused by a second domain rather than renamed —
 * a rename would cost a DSQL DDL migration for cosmetic benefit (ADR-0012).
 */
export type ProcessingState = {
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "INTERRUPTED"
  /** Absent on every row written before ADR-0012 and therefore means `PM_INTERVIEW`. */
  kind?: HandoffKind
  deadline?: number
  claimId?: string
  /** `PM_INTERVIEW` only. */
  interviewId?: string
  /** `RESEARCH_SYNTHESIS` only: the single study this claim is bound to. */
  studyId?: string
  targetUrl?: string
  receipt?: { changedFields: string[]; targetUrl: string; payloadHash?: string; before?: Record<string, unknown>; after?: Record<string, unknown> }
}

/**
 * Migrations 050/051 are applied in production, so live rows predate `kind`.
 * Absence must keep meaning `PM_INTERVIEW` indefinitely — there is no backfill.
 */
export function handoffKind(state: ProcessingState): HandoffKind {
  return state.kind ?? "PM_INTERVIEW"
}

/** Guards the PM-only target/field logic against a state from another domain. */
export function assertPmInterviewKind(state: ProcessingState) {
  if (handoffKind(state) !== "PM_INTERVIEW") throw new Error("This conversation is not a PM interview handoff")
}

export function processingStatus(state: ProcessingState, now = Date.now()) {
  if (state.receipt) return "SUCCEEDED"
  if (state.status === "RUNNING" && (!state.deadline || state.deadline <= now)) return "INTERRUPTED"
  return state.status
}

export function assertInterviewToolInput(type: string, targetId: string, tool: string, args: Record<string, unknown>) {
  const kind = type.toLowerCase()
  if (tool !== `update_${kind}` || args[`${kind}Id`] !== targetId) throw new Error("Tool target is outside this interview")
  const fields = PM_INTERVIEW_ALLOWED_FIELDS[type as PmInterviewTargetType]
  if (!fields) throw new Error("Unsupported interview target")
  for (const key of Object.keys(args)) {
    if (key !== `${kind}Id` && key !== "expectedUpdatedAt" && key !== "expectedFieldsFingerprint" && !(fields as readonly string[]).includes(key)) throw new Error(`Field is outside this interview: ${key}`)
  }
}

export function parseProcessingState(raw: string | null | undefined): ProcessingState | null {
  if (!raw) return null
  const state = JSON.parse(raw) as ProcessingState
  if (!["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "INTERRUPTED"].includes(state.status)) throw new Error("Invalid interview processing state")
  // Absent `kind` is the legacy shape and stays valid; anything present must be known.
  if (state.kind !== undefined && !(HANDOFF_KINDS as readonly unknown[]).includes(state.kind)) throw new Error("Unsupported interview processing kind")
  return state
}
import { PM_INTERVIEW_ALLOWED_FIELDS, type PmInterviewTargetType } from "@/lib/pm-interview-contracts"
