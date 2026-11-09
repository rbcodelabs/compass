import type { McpActor } from "@/lib/mcp-authz"
import { fail, ok, type ToolResult } from "@/lib/mcp-output"
import { ToolApprovalError } from "@/lib/tool-approval/errors"
import { canonicalJson } from "@/lib/tool-approval/packet"
import { getToolApprovalSpec } from "@/lib/tool-approval/registry"
import { requestToolApproval } from "@/lib/tool-approval/request"
import { restBypassProblem } from "@/lib/tool-approval/rest-guard"

const show = (value: unknown): string => {
  const text = canonicalJson(value) ?? "null"
  return text.length > 800 ? `${text.slice(0, 800)}…` : text
}

/**
 * The one hook in app/api/mcp/route.ts register(), run after the authorization gate and display-id resolution. Returns null
 * for every tool that has not opted in (the production registry is empty, so that is every tool today) without touching the
 * database. For an opted-in tool it NEVER lets the handler run: it files (or reuses) an approval request and returns a
 * structured "approval required" result. Any failure also returns a refusal: it fails closed, never falls through.
 * No argument or header the caller supplies can mark a call as already approved; execution belongs to the executor alone.
 */
export async function interceptToolForApproval(input: {
  toolName: string
  actor: McpActor
  resolveArgs: () => Promise<Record<string, unknown>>
}): Promise<ToolResult | null> {
  if (!getToolApprovalSpec(input.toolName)) return null
  const notDone = { executed: false }
  if (restBypassProblem(input.toolName)) {
    return fail("Approval is unavailable for this action right now. It was NOT performed.", { status: "APPROVAL_UNAVAILABLE", ...notDone })
  }
  try {
    const outcome = await requestToolApproval({
      toolName: input.toolName,
      args: await input.resolveArgs(),
      requester: { userId: input.actor.userId ?? null, agentId: input.actor.agentId ?? null },
    })
    if (outcome.status === "BLOCKED") {
      return fail(`This action is blocked and cannot be approved: ${outcome.floors.join("; ")}. It was NOT performed.`, { status: "BLOCKED", ...notDone, floors: outcome.floors })
    }
    if (outcome.status === "NOT_REGISTERED") {
      return fail("Approval is unavailable for this action right now. It was NOT performed.", { status: "APPROVAL_UNAVAILABLE", ...notDone })
    }
    const lines = [
      "Approval required. The action was NOT performed.",
      `Status: APPROVAL_REQUIRED`,
      `ID: ${outcome.requestId}`,
      outcome.displayId ? `Display ID: ${outcome.displayId}` : null,
      `Action: ${outcome.title}`,
      outcome.summary ? `Summary: ${outcome.summary}` : null,
      `Current: ${show(outcome.before)}`,
      `Proposed: ${show(outcome.after)}`,
      `Approve or deny at: ${outcome.path}`,
      outcome.reused ? "An identical request was already waiting; no new request was created." : null,
      "A workspace admin must approve this in Compass before it runs. Tell them where to look; do not retry the call.",
    ].filter((line): line is string => line !== null)
    return ok(lines.join("\n"), {
      status: "APPROVAL_REQUIRED", ...notDone, requestId: outcome.requestId, displayId: outcome.displayId, revisionId: outcome.revisionId,
      path: outcome.path, title: outcome.title, summary: outcome.summary, before: outcome.before, after: outcome.after,
      expiresAt: outcome.expiresAt?.toISOString() ?? null, reused: outcome.reused,
    })
  } catch (error) {
    if (error instanceof ToolApprovalError && (error.code === "TOO_MANY_PENDING" || error.code === "REQUESTER_LIMIT")) {
      return fail(`${error.message} The action was NOT performed.`, { status: error.code, ...notDone })
    }
    // Log the failure class only: args and state may carry data the caller must not echo into logs.
    console.error("Tool approval could not be requested", { tool: input.toolName, error: error instanceof Error ? error.name : "unknown", code: (error as { code?: string }).code })
    return fail("An approval could not be requested, so the action was NOT performed.", { status: "APPROVAL_UNAVAILABLE", ...notDone })
  }
}
