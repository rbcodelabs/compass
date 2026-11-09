/**
 * The one place the approval surfaces turn a click into a decision. Plain module (not a "use server" file) so tests can call it
 * directly; the server actions in actions.ts are thin wrappers that supply the signed-in user and the workspace.
 *
 * Trust model: the acting user comes from the session (the caller passes it; nothing in the form is believed), admin
 * authority is re-checked here at action time, the request must belong to the workspace the URL / chat named, and the decision
 * itself still goes through decideToolApproval, which re-verifies admin, freshness, expiry and the stored fingerprint.
 */
import getPrisma from "@/lib/db"
import { isWorkspaceAdminUser } from "@/lib/agent-ownership"
import { ToolApprovalError } from "@/lib/tool-approval/errors"
import { decideToolApproval } from "@/lib/tool-approval/decide"
import { addApprovalUpdateToConversation } from "@/lib/tool-approval/conversation"
import { describeDecisionError, describeExecution, type ApprovalActionResult } from "@/lib/tool-approval/messages"
import { isUuid, loadApprovalView } from "@/lib/tool-approval/view"

export type ApprovalDecisionInput = {
  userId: string
  workspaceId: string
  requestId: string
  action: "APPROVE" | "REJECT"
  idempotencyKey: string
  /** Chat only: the conversation to tell. Checked against the user's own access; ignored when invalid or inaccessible. */
  conversationId?: string | null
}

const KEY = /^[A-Za-z0-9_-]{16,100}$/
const fail = (message: string): ApprovalActionResult => ({ ok: false, tone: "danger", message })

export async function runApprovalDecision(input: ApprovalDecisionInput): Promise<ApprovalActionResult> {
  if (!isUuid(input.userId) || !isUuid(input.workspaceId) || !isUuid(input.requestId)) return fail("That approval could not be found.")
  if (input.action !== "APPROVE" && input.action !== "REJECT") return fail("Choose approve or deny.")
  if (!KEY.test(input.idempotencyKey)) return fail("The submission was not valid. Refresh the page and try again.")

  const prisma = getPrisma()
  if (!(await isWorkspaceAdminUser(prisma, input.userId, input.workspaceId))) return fail("Only a workspace admin can decide a tool approval.")
  // The id alone never selects a row: it must be a tool approval inside the workspace the caller named.
  if (!(await loadApprovalView(prisma, { requestId: input.requestId, workspaceId: input.workspaceId }))) return fail("That approval could not be found in this workspace.")

  let result: ApprovalActionResult
  try {
    const { execution } = await decideToolApproval({ requestId: input.requestId, optionActionKey: input.action, actingUserId: input.userId, idempotencyKey: input.idempotencyKey })
    result = describeExecution(input.action === "APPROVE" ? execution : null)
  } catch (error) {
    const code = (error as { code?: unknown })?.code
    if (error instanceof ToolApprovalError || (error instanceof Error && error.name === "DecisionError")) {
      result = describeDecisionError(typeof code === "string" ? code : undefined)
    } else {
      // Class only: never log arguments or state.
      console.error("Tool approval decision failed unexpectedly", { error: error instanceof Error ? error.name : "unknown" })
      result = fail("Something went wrong. Refresh to see the current status; an approval is never run twice.")
    }
  }

  // Read the stored state back: it, not the click's own outcome, is what the page and the agent are told.
  const view = await loadApprovalView(prisma, { requestId: input.requestId, workspaceId: input.workspaceId })
  if (view) result = { ...result, state: view.state.key }
  if (view && view.state.key !== "PENDING" && isUuid(input.conversationId)) {
    try {
      await addApprovalUpdateToConversation(prisma, { conversationId: input.conversationId, workspaceId: input.workspaceId, userId: input.userId, view })
    } catch (error) {
      console.error("Tool approval could not be reported to the conversation", { error: error instanceof Error ? error.name : "unknown" })
    }
  }
  return result
}
