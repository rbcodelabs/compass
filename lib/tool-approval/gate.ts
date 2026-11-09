/**
 * The TOOL_APPROVAL gate: a human admin approves one concrete MCP tool call before it runs.
 *
 * This file is deliberately dependency-free (no Prisma, no next/*) so low-level readers
 * (decision-service, tracked-decisions, REST) can import it without an import cycle with the
 * request/executor modules, which depend on them.
 */

export const TOOL_APPROVAL_GATE = "TOOL_APPROVAL" as const

/** ReviewOption.continuationKey of the Approve option; the executor refuses any other. */
export const EXECUTE_TOOL_APPROVAL_CONTINUATION = "EXECUTE_TOOL_APPROVAL" as const

/** Prisma `where` fragment every generic review/decision reader spreads in so approvals never leak into those surfaces. */
export const excludeToolApprovals = { gateType: { not: TOOL_APPROVAL_GATE } } as const

export function isToolApprovalGate(gateType: string | null | undefined): boolean {
  return gateType === TOOL_APPROVAL_GATE
}

/**
 * Capability token for recordDecision on a TOOL_APPROVAL request. Only lib/tool-approval/decide.ts imports it, so a
 * generic surface (server action, REST, MCP) cannot record a decision that nothing would ever execute. A module-private
 * Symbol (not Symbol.for) cannot be forged from outside this module graph.
 */
export const TOOL_APPROVAL_DECISION_CHANNEL: unique symbol = Symbol("tool-approval-decision-channel")
export type ToolApprovalDecisionChannel = typeof TOOL_APPROVAL_DECISION_CHANNEL

/** The dedicated approval surface (built in A3). */
export function toolApprovalPath(orgSlug: string, workspaceSlug: string, requestId: string): string {
  return `/${orgSlug}/${workspaceSlug}/approvals/${requestId}`
}

export const TOOL_APPROVAL_SURFACE_MESSAGE =
  "This is a tool approval. It can only be decided on the dedicated approval page, which also runs the approved action."
