"use server"

import { revalidatePath } from "next/cache"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { isOrgAdminRole } from "@/lib/roles"
import { isWorkspaceAdminUser } from "@/lib/agent-ownership"
import type { ApprovalActionResult } from "@/lib/tool-approval/messages"
import { addApprovalUpdateToConversation } from "@/lib/tool-approval/conversation"
import { isUuid, loadApprovalView, type ApprovalView } from "@/lib/tool-approval/view"
import { runApprovalDecision } from "./decision-core"

type Action = "APPROVE" | "REJECT"
const signedOut: ApprovalActionResult = { ok: false, tone: "danger", message: "Sign in again to continue." }
const notFound: ApprovalActionResult = { ok: false, tone: "danger", message: "That approval could not be found." }

/** The approval page. The workspace is resolved from the URL's slugs, so a request id from another workspace finds nothing. */
export async function decideApprovalAction(
  scope: { orgSlug: string; workspaceSlug: string; requestId: string },
  action: Action,
  idempotencyKey: string,
): Promise<ApprovalActionResult> {
  const session = await auth()
  if (!session?.user?.id) return signedOut
  const workspace = await getPrisma().workspace.findFirst({ where: { slug: String(scope.workspaceSlug), organization: { slug: String(scope.orgSlug) } }, select: { id: true } })
  if (!workspace) return notFound
  const result = await runApprovalDecision({ userId: session.user.id, workspaceId: workspace.id, requestId: String(scope.requestId), action, idempotencyKey: String(idempotencyKey) })
  revalidatePath(`/${scope.orgSlug}/${scope.workspaceSlug}/approvals/${scope.requestId}`)
  revalidatePath(`/${scope.orgSlug}/${scope.workspaceSlug}/approvals`)
  return result
}

/** The chat card. The workspace comes from the open chat; admin authority and the request's workspace are still checked server-side. */
export async function decideApprovalFromChatAction(
  scope: { workspaceId: string; requestId: string; conversationId: string | null },
  action: Action,
  idempotencyKey: string,
): Promise<ApprovalActionResult> {
  const session = await auth()
  if (!session?.user?.id) return signedOut
  return runApprovalDecision({
    userId: session.user.id, workspaceId: String(scope.workspaceId), requestId: String(scope.requestId), action,
    idempotencyKey: String(idempotencyKey), conversationId: scope.conversationId ? String(scope.conversationId) : null,
  })
}

export type ApprovalCardData = {
  /** For a non-admin member the title, summary, tool and effect are blanked (effectWithheld): only status is shown. */
  view: ApprovalView
  canDecide: boolean
  effectWithheld: boolean
}

/**
 * Fresh stored state for one approval, for the chat card. Null unless the caller belongs to the workspace and the request is a
 * tool approval inside it. Non-admins get the status but not what the call does, matching the 404 the approval page gives them.
 * An admin who names a conversation also triggers the once-only "how it ended" message once the state is final (see above).
 */
export async function getApprovalCardAction(scope: { workspaceId: string; requestId: string; conversationId?: string | null }): Promise<ApprovalCardData | null> {
  const session = await auth()
  if (!session?.user?.id || !isUuid(scope.workspaceId) || !isUuid(scope.requestId)) return null
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findFirst({
    where: { id: scope.workspaceId },
    select: { members: { where: { userId: session.user.id }, select: { id: true } }, organization: { select: { members: { where: { userId: session.user.id }, select: { role: true } } } } },
  })
  if (!workspace || (workspace.members.length === 0 && !isOrgAdminRole(workspace.organization?.members[0]?.role))) return null
  const view = await loadApprovalView(prisma, { requestId: scope.requestId, workspaceId: scope.workspaceId })
  if (!view) return null
  if (await isWorkspaceAdminUser(prisma, session.user.id, scope.workspaceId)) {
    // The click that decided this may have returned while the run was still unfinished, so the agent was not told. The first
    // time an admin's card sees a FINAL state it asks for the same once-only message (deduped by id; scoped to the requester's
    // own conversation and to what this person can access).
    if (view.state.terminal && isUuid(scope.conversationId)) {
      try {
        await addApprovalUpdateToConversation(prisma, { conversationId: scope.conversationId, workspaceId: scope.workspaceId, userId: session.user.id, view })
      } catch (error) {
        console.error("Tool approval could not be reported to the conversation", { error: error instanceof Error ? error.name : "unknown" })
      }
    }
    return { view, canDecide: true, effectWithheld: false }
  }
  return { view: { ...view, title: "Tool approval", summary: "", tool: "", capabilityClass: "", args: null, before: null, after: null, decision: view.decision && { ...view.decision, decidedByName: null }, receipt: null }, canDecide: false, effectWithheld: true }
}
