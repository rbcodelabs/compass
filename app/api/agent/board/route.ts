/**
 * Card list for the agent board (components/agent/agent-board.tsx), which polls it to
 * reflect run status changes. The server page paints the first frame from the same
 * `listAgentBoardCards`, so the two cannot disagree.
 *
 * `workspaceId` arrives as an unvalidated query parameter, so it is not trusted: the
 * shared access predicate (lib/agent-conversation-access.ts) includes the live
 * workspace-membership check, and a non-member simply gets an empty board.
 */

import { z } from "zod"

import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { listAgentBoardCards } from "@/lib/agent-board-data"

// The column is `@db.Uuid`; a malformed id would otherwise surface as a Prisma 500.
const uuid = z.string().uuid()

export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })

  const workspaceId = new URL(request.url).searchParams.get("workspaceId")
  if (!workspaceId || !uuid.safeParse(workspaceId).success) return new Response("Workspace required", { status: 400 })

  const cards = await listAgentBoardCards(getPrisma(), { workspaceId, userId: session.user.id })
  return Response.json({ cards })
}
