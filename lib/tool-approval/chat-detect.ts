/**
 * Finds the approval request ids in an agent turn's tool results, so the chat can draw a card for each.
 *
 * The id is only a LOOKUP KEY: the card never shows anything from the result text. It fetches the stored request from the
 * server, scoped to the open workspace, so text that merely looks like an approval result (a web page the agent read, a
 * hostile document) can at most point the card at a real request in this workspace, whose true content is then shown.
 * The shape matched is the opening of the MCP hook's own result (lib/tool-approval/mcp-hook.ts), after the transcript has
 * collapsed whitespace.
 */
import type { ToolStep } from "@/lib/agent-run-stream"

const APPROVAL_RESULT = /^Approval required\.\s+The action was NOT performed\.\s+Status:\s+APPROVAL_REQUIRED\s+ID:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\s|$)/i

export function approvalRequestIdFromResult(result: string | undefined): string | null {
  const match = result ? APPROVAL_RESULT.exec(result.trim()) : null
  return match ? match[1].toLowerCase() : null
}

/** Distinct request ids, in the order the agent hit them. Only finished steps count: a running tool has no result yet. */
export function approvalRequestIds(steps: ReadonlyArray<Pick<ToolStep, "status" | "result">>): string[] {
  const ids: string[] = []
  for (const step of steps) {
    if (step.status === "running") continue
    const id = approvalRequestIdFromResult(step.result)
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}
