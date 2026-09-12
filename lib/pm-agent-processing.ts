export type ProcessingState = {
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "INTERRUPTED"
  deadline?: number
  claimId?: string
  interviewId?: string
  targetUrl?: string
  receipt?: { changedFields: string[]; targetUrl: string; payloadHash?: string; before?: Record<string, unknown>; after?: Record<string, unknown> }
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
  return state
}
import { PM_INTERVIEW_ALLOWED_FIELDS, type PmInterviewTargetType } from "@/lib/pm-interview-contracts"
