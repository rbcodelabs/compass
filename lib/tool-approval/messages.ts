/**
 * Fixed, human-readable wording for everything the approval surfaces tell a person. Executor and decision-service reason codes
 * map to our own sentences; no stored or agent-supplied text (title, summary, arguments) is interpolated into them, except the
 * executor's already-sanitised error line which is shown separately.
 */
import type { ExecuteOutcome, RefusalReason } from "@/lib/tool-approval/executor"
import { sanitizeText } from "@/lib/tool-approval/sanitize"
import { APPROVAL_STATES, type ApprovalStateKey, type ApprovalTone } from "@/lib/tool-approval/state"

export type ApprovalActionResult = {
  ok: boolean
  tone: ApprovalTone
  message: string
  /** Set when the stored state could be read back after the attempt. */
  state?: ApprovalStateKey
}

/** Trims trailing sentence punctuation and spaces so the caller can end the clause with exactly one period. */
const endClause = (text: string): string => text.trim().replace(/[\s.;:,]+$/, "")

/** Each entry is a complete sentence of its own: it is appended after a full sentence, never glued into one. */
const REFUSALS: Record<RefusalReason, string> = {
  NO_DECISION: "The decision could not be found, so nothing ran.",
  WRONG_GATE: "This is not a tool approval, so nothing ran.",
  NOT_CURRENT: "This approval is no longer the current one, so nothing ran.",
  OPTION_MISMATCH: "The chosen option does not belong to this approval, so nothing ran.",
  NOT_AN_APPROVAL: "That option does not approve the action, so nothing ran.",
  PACKET_INVALID: "The stored request could not be read, so nothing ran.",
  FINGERPRINT_MISMATCH: "The stored request was altered after it was filed, so nothing ran.",
  WORKSPACE_MISMATCH: "The request does not match this workspace, so nothing ran.",
  TOOL_NOT_REGISTERED: "This tool is not available for approval right now, so nothing ran.",
  TOOL_MISMATCH: "The tool no longer matches what was approved, so nothing ran.",
  APPROVER_NOT_ADMIN_NOW: "The approver is no longer a workspace admin, so nothing ran.",
  EXPIRED: "The request expired before it could run, so nothing ran. Ask for a fresh one.",
  APPROVAL_STALE: "The approval is more than 15 minutes old, so nothing ran. Ask for a fresh one.",
}

/** What the person who just clicked should read, for the executor's answer to an approval. */
export function describeExecution(outcome: ExecuteOutcome | null): ApprovalActionResult {
  if (!outcome) return { ok: true, tone: "neutral", message: "Denied. The action was not performed.", state: "DENIED" }
  switch (outcome.status) {
    case "EXECUTED": return { ok: true, tone: "success", message: "Approved. The action ran once.", state: "APPLIED" }
    case "FAILED": return { ok: false, tone: "danger", message: `Approved, but the action failed (${endClause(sanitizeText(outcome.error))}). It will not be retried; a fresh request is needed.`, state: "FAILED" }
    case "STALE": return { ok: false, tone: "warning", message: `${APPROVAL_STATES.STALE.explanation}`, state: "STALE" }
    case "BLOCKED": return { ok: false, tone: "danger", message: `Approved, but a hard limit blocks this action: ${endClause(outcome.floors.map(sanitizeText).join("; "))}. Nothing ran.`, state: "BLOCKED" }
    case "ALREADY_APPLIED": return { ok: true, tone: "info", message: `This approval was already processed (${outcome.receiptStatus.toLowerCase()}). It was not run again.` }
    case "UNKNOWN_OUTCOME": return { ok: false, tone: "danger", message: APPROVAL_STATES.UNKNOWN_OUTCOME.explanation, state: "UNKNOWN_OUTCOME" }
    case "REFUSED": return { ok: false, tone: "warning", message: `Approved, but the action did not run. ${REFUSALS[outcome.reason] ?? "Nothing ran."}`, state: "NOT_RUN" }
  }
}

const DECISION_ERRORS: Record<string, string> = {
  REVISION_NOT_PENDING: "This request has already been decided or closed.",
  ALREADY_DECIDED: "This request has already been decided.",
  REVISION_EXPIRED: "This request has expired. Ask for a fresh one.",
  ADMIN_REQUIRED: "Only a workspace admin can decide a tool approval.",
  ACCESS_DENIED: "You do not have access to this workspace.",
  STALE_FINGERPRINT: "The request changed after this page loaded. Refresh and review it again.",
  IDEMPOTENCY_KEY_CONFLICT: "That submission does not match an earlier one. Refresh and try again.",
  HUMAN_ACTOR_REQUIRED: "A signed-in person must make this decision.",
}

/** Reason codes from the decision service (a DecisionError or ToolApprovalError `code`) as a sentence. */
export function describeDecisionError(code: string | undefined): ApprovalActionResult {
  const known = code ? DECISION_ERRORS[code] : undefined
  if (code === "REQUEST_NOT_FOUND" || code === "OPTION_NOT_FOUND") return { ok: false, tone: "danger", message: "That approval could not be found." }
  return { ok: false, tone: "danger", message: known ?? "The decision could not be recorded. Nothing ran. Refresh and try again." }
}

/** Tool names are registry constants, but cap and strip them anyway before they go anywhere near a conversation. */
export function safeToolName(tool: string): string {
  return tool.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64) || "tool"
}

/**
 * The one message added to an agent conversation after a human acts on an approval. A fixed template: the state label, the
 * display id, the request id and a sanitised tool name. No title, summary or argument text, so a request cannot smuggle
 * instructions into the agent's next turn.
 */
export function conversationUpdateText(input: { state: ApprovalStateKey; requestId: string; displayId: string | null; tool: string }): string {
  const ref = input.displayId ? `${input.displayId} (${input.requestId})` : input.requestId
  const outcome: Record<ApprovalStateKey, string> = {
    APPLIED: "The admin approved it and the action ran once.",
    DENIED: "The admin denied it. The action was NOT performed.",
    APPLYING: "The admin approved it and the action is running.",
    PENDING: "It is still waiting for an admin.",
    EXPIRED: "It expired without a decision. The action was NOT performed.",
    STALE: "The admin approved it, but the target changed since review, so nothing ran. The action was NOT performed.",
    FAILED: "The admin approved it, but the action failed. It will not be retried.",
    UNKNOWN_OUTCOME: "The admin approved it, but whether the action ran is unknown. An operator must check. Do not retry.",
    BLOCKED: "The admin approved it, but a hard limit blocks the action. The action was NOT performed.",
    NOT_RUN: "The admin approved it, but it did not run. The action was NOT performed.",
    SUPERSEDED: "It was replaced or closed. The action was NOT performed.",
  }
  return `${APPROVAL_UPDATE_PREFIX}Tool approval ${ref} for ${safeToolName(input.tool)}: ${APPROVAL_STATES[input.state].label}. ${outcome[input.state]} Do not retry the call unless asked.`
}

export const APPROVAL_UPDATE_PREFIX = "[Approval update] "

/** True for the message conversationUpdateText produces, so the chat can show it as system-generated rather than as typed by a person. */
export function isApprovalUpdateMessage(content: string): boolean {
  return content.startsWith(APPROVAL_UPDATE_PREFIX)
}
