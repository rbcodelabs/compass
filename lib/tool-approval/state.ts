/**
 * Maps what is stored about one approval (request, revision, decision, executor receipt) to the single status a person sees.
 * Pure and dependency-free so the server pages and the client chat card use the same words.
 */

export type ApprovalStateKey =
  | "PENDING" | "APPLYING" | "APPLIED" | "DENIED" | "EXPIRED" | "STALE" | "FAILED" | "UNKNOWN_OUTCOME" | "BLOCKED" | "NOT_RUN" | "SUPERSEDED"

export type ApprovalTone = "neutral" | "info" | "success" | "warning" | "danger"

export type ApprovalStateInfo = {
  key: ApprovalStateKey
  label: string
  tone: ApprovalTone
  /** One sentence for the page: what this status means and what, if anything, happens next. */
  explanation: string
  /** No further change is expected; the page shows no buttons and stops refreshing. */
  terminal: boolean
}

/** How long a just-approved call may sit without a finished receipt and still read as "running now". */
export const APPLYING_WINDOW_MS = 2 * 60 * 1000

export const APPROVAL_STATES: Record<ApprovalStateKey, Omit<ApprovalStateInfo, "key">> = {
  PENDING: { label: "Pending", tone: "warning", terminal: false, explanation: "Waiting for a workspace admin to approve or deny. Nothing has run." },
  APPLYING: { label: "Applying", tone: "info", terminal: false, explanation: "Approved. The action is running now." },
  APPLIED: { label: "Applied", tone: "success", terminal: true, explanation: "Approved and the action ran once." },
  DENIED: { label: "Denied", tone: "danger", terminal: true, explanation: "An admin denied this. The action was not performed." },
  EXPIRED: { label: "Expired", tone: "neutral", terminal: true, explanation: "No one decided in time. The action was not performed; the caller must ask again." },
  STALE: { label: "Stale", tone: "warning", terminal: true, explanation: "Approved, but what the action would change moved after it was reviewed, so nothing ran. A fresh request is needed." },
  FAILED: { label: "Failed", tone: "danger", terminal: true, explanation: "Approved, but the action failed. It is recorded and will not be retried; a fresh request is needed." },
  UNKNOWN_OUTCOME: { label: "Unknown outcome", tone: "danger", terminal: true, explanation: "Approved, but the run did not report a result, so it is not known whether the action happened. It will not be retried automatically. An operator must check the target and the receipt." },
  BLOCKED: { label: "Blocked", tone: "danger", terminal: true, explanation: "Approved, but a hard limit blocks this action regardless of approval. Nothing ran." },
  NOT_RUN: { label: "Approved, not run", tone: "warning", terminal: true, explanation: "Approved, but the action did not run (the approval window passed, the approver lost admin access, or the tool is no longer available). A fresh request is needed." },
  SUPERSEDED: { label: "Replaced", tone: "neutral", terminal: true, explanation: "This request was replaced by a newer one or closed. Nothing ran." },
}

export type ApprovalStateInput = {
  requestState: string
  revisionSupersededAt: Date | null
  revisionExpiresAt: Date | null
  decision: { outcomeClass: string; decidedAt: Date } | null
  receipt: { status: string; updatedAt: Date } | null
  /** Whether the tool still has an approval spec; without one an approved call cannot run. */
  toolRegistered: boolean
  now: Date
}

const info = (key: ApprovalStateKey): ApprovalStateInfo => ({ key, ...APPROVAL_STATES[key] })

export function deriveApprovalState(input: ApprovalStateInput): ApprovalStateInfo {
  const { decision, receipt, now } = input
  if (decision) {
    if (decision.outcomeClass !== "APPROVE") return info("DENIED")
    if (receipt) {
      switch (receipt.status) {
        case "APPLIED": return info("APPLIED")
        case "FAILED": return info("FAILED")
        case "STALE": return info("STALE")
        case "BLOCKED": return info("BLOCKED")
        case "PENDING": return now.getTime() - receipt.updatedAt.getTime() < APPLYING_WINDOW_MS ? info("APPLYING") : info("UNKNOWN_OUTCOME")
        default: return info("UNKNOWN_OUTCOME")
      }
    }
    // Approved but no receipt: either the executor is about to claim it, or it refused before claiming (nothing ran).
    return input.toolRegistered && now.getTime() - decision.decidedAt.getTime() < APPLYING_WINDOW_MS ? info("APPLYING") : info("NOT_RUN")
  }
  if (input.requestState === "SUPERSEDED" || input.revisionSupersededAt) return info("SUPERSEDED")
  if (input.revisionExpiresAt && input.revisionExpiresAt <= now) return info("EXPIRED")
  if (input.requestState === "PENDING") return info("PENDING")
  return info("SUPERSEDED")
}
