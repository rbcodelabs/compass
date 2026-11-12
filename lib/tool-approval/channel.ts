/**
 * Capability token for recordDecision on a TOOL_APPROVAL request. ONLY lib/tool-approval/decide.ts may import
 * TOOL_APPROVAL_DECISION_CHANNEL (asserted by __tests__/tool-approval-imports.test.ts); every other module checks a token
 * through isToolApprovalChannel. A module-private Symbol (not Symbol.for) cannot be forged from outside this module graph.
 * This file is deliberately NOT re-exported from lib/tool-approval/index.ts.
 */
export const TOOL_APPROVAL_DECISION_CHANNEL: unique symbol = Symbol("tool-approval-decision-channel")
export type ToolApprovalDecisionChannel = typeof TOOL_APPROVAL_DECISION_CHANNEL

export function isToolApprovalChannel(token: unknown): token is ToolApprovalDecisionChannel {
  return token === TOOL_APPROVAL_DECISION_CHANNEL
}
