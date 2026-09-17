import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { handoffKind, parseProcessingState, processingStatus } from "@/lib/pm-agent-processing"

export async function GET(request: Request, { params }: { params: Promise<{ conversationId: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })
  const workspaceId = new URL(request.url).searchParams.get("workspaceId")
  if (!workspaceId) return new Response("Workspace required", { status: 400 })
  const { conversationId } = await params
  const conversation = await getPrisma().agentConversation.findFirst({ where: { id: conversationId, workspaceId, userId: session.user.id, workspace: { members: { some: { userId: session.user.id } } } } })
  const state = parseProcessingState(conversation?.interviewProcessingJson)
  if (!state) return new Response("Not found", { status: 404 })
  const status = processingStatus(state)
  // `kind` and `targetUrl` let the client render the right panel for a handoff
  // that is not a PM interview (ADR-0012 step 4). Existing fields are unchanged,
  // and legacy rows without a `kind` still report PM_INTERVIEW.
  return Response.json({ status, kind: handoffKind(state), receipt: state.receipt ?? null, interviewId: state.interviewId, targetUrl: state.targetUrl ?? null, canContinue: !["PENDING", "RUNNING"].includes(status) })
}
