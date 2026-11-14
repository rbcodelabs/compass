/**
 * Card list for the agent board (components/agent/agent-board.tsx), which uses it as the
 * fallback/refresh snapshot alongside `/api/agent/board/stream`. The server page paints the
 * first frame from the same `listAgentBoardCards`, so the two cannot disagree.
 *
 * `workspaceId` arrives as an unvalidated query parameter, so it is not trusted: the
 * shared access predicate (lib/agent-conversation-access.ts) includes the live
 * workspace-membership check, and a non-member simply gets an empty board.
 */

import { z } from "zod"

import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { listAgentBoardCards, listWorkspaceBoardSquads } from "@/lib/agent-board-data"

// The column is `@db.Uuid`; a malformed id would otherwise surface as a Prisma 500.
const uuid = z.string().uuid()

export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })

  const params = new URL(request.url).searchParams
  const workspaceId = params.get("workspaceId")
  if (!workspaceId || !uuid.safeParse(workspaceId).success) return new Response("Workspace required", { status: 400 })

  const prisma = getPrisma()
  const userId = session.user.id
  if (params.get("includeSquads") === "1") {
    const [cards, squads] = await Promise.all([
      listAgentBoardCards(prisma, { workspaceId, userId }),
      listWorkspaceBoardSquads(prisma, { workspaceId, userId }),
    ])
    return Response.json({ cards, squads })
  }

  const cards = await listAgentBoardCards(prisma, { workspaceId, userId })
  return Response.json({ cards })
}
