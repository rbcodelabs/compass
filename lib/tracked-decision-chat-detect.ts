/**
 * Detects tracked decision requests raised by an agent (`request_decision` MCP tool) in a chat turn's tool results
 * and in persisted assistant messages on reload (`/{org}/{workspace}/reviews/{uuid}` or `?detail=review:{uuid}`).
 *
 * Security invariant (matching `lib/tool-approval/chat-detect.ts`):
 * The parsed UUID is used ONLY as a lookup key against `/api/panels/review/[id]?orgSlug=...&workspaceSlug=...`,
 * which enforces session authentication, workspace membership, and `excludeToolApprovals` (so a `TOOL_APPROVAL`
 * gate can never render or be decided here, and untrusted text in a tool result can never spoof card content).
 */
import type { ToolStep } from "@/lib/agent-run-stream"

const DECISION_REQUEST_RESULT = /^Decision requested\.\s+ID:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\s|$)/i
const UUID_PART = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function trackedDecisionRequestIdFromResult(result: string | undefined): string | null {
  const match = result ? DECISION_REQUEST_RESULT.exec(result.trim()) : null
  return match ? match[1].toLowerCase() : null
}

/** Distinct tracked decision request IDs in encounter order across finished tool steps. */
export function trackedDecisionRequestIds(steps: ReadonlyArray<Pick<ToolStep, "status" | "result">>): string[] {
  const ids: string[] = []
  for (const step of steps) {
    if (step.status === "running") continue
    const id = trackedDecisionRequestIdFromResult(step.result)
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * Extracts distinct decision request UUIDs referenced in a persisted assistant message for `basePath` (`/org/workspace`),
 * so reloaded threads (whose stored rows carry `content` without `toolCalls`) keep rendering the inline quick card.
 */
export function trackedDecisionIdsFromText(text: string | undefined, basePath: string | undefined): string[] {
  if (!text || !basePath) return []
  const normalizedBase = "/" + basePath.split("/").filter(Boolean).map(escapeRegExp).join("/")
  if (normalizedBase === "/") return []

  const ids: string[] = []
  const reviewPathPattern = new RegExp(`${normalizedBase}\\/reviews\\/${UUID_PART}(?![0-9a-f-])`, "gi")
  for (const match of text.matchAll(reviewPathPattern)) {
    const id = match[1].toLowerCase()
    if (!ids.includes(id)) ids.push(id)
  }

  const detailParamPattern = new RegExp(`${normalizedBase}(?:\\/[^\\s)"'<>?]*)?\\?[^\\s)"'<>]*detail=review(?:%3A|:)${UUID_PART}(?![0-9a-f-])`, "gi")
  for (const match of text.matchAll(detailParamPattern)) {
    const id = match[1].toLowerCase()
    if (!ids.includes(id)) ids.push(id)
  }

  return ids
}
