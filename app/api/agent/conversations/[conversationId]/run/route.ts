/**
 * The in-flight run for one conversation, so a reopened tab can reattach
 *.
 *
 * This is the entry point for "I closed the tab mid-turn and came back". The
 * client cannot ask for a run it has never heard of by id, and the conversation
 * is the only handle it still has — so the lookup is conversation → active run,
 * and everything after that is the run routes.
 *
 * Deliberately not folded into the sibling `processing` route: that one 404s
 * unless the conversation has a handoff claim, so it is blind to the ordinary
 * chat turns that make up most runs.
 */

import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { agentRunsAvailable, findActiveAgentRun, getAgentRunForViewer } from "@/lib/agent-runs"
import { serializeAgentRun } from "@/lib/agent-run-view"

export const runtime = "nodejs"

export async function GET(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })
  const userId = session.user.id
  const workspaceId = new URL(request.url).searchParams.get("workspaceId")
  if (!workspaceId) return new Response("Workspace required", { status: 400 })
  const { conversationId } = await context.params

  const prisma = getPrisma()
  // Ownership first, and as a 404 — the same shape the sibling message route
  // uses, so a conversation belonging to someone else is indistinguishable from
  // one that does not exist.
  const conversation = await prisma.agentConversation.findFirst({
    where: { id: conversationId, workspaceId, userId, workspace: { members: { some: { userId } } } },
    select: { id: true },
  })
  if (!conversation) return new Response("Not found", { status: 404 })

  const json = (value: unknown) => Response.json(value, { headers: { "cache-control": "no-store" } })
  // Before migration 069 there are no runs to find, and the client's reattach
  // path must degrade to "nothing in flight" rather than to an error banner.
  if (!(await agentRunsAvailable(prisma))) return json({ run: null, available: false })

  const active = await findActiveAgentRun({ prisma, conversationId })
  if (!active) return json({ run: null, available: true })
  const run = await getAgentRunForViewer({ prisma, runId: active.id, userId })
  return json({ run: run ? serializeAgentRun(run) : null, available: true })
}
