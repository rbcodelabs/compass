import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { parseProcessingState, processingStatus } from "@/lib/pm-agent-processing"

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
  return Response.json({ status, receipt: state.receipt ?? null, interviewId: state.interviewId, canContinue: !["PENDING", "RUNNING"].includes(status) })
}
