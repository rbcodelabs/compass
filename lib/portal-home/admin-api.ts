import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { ZodError } from "zod"
import getPrisma, { type AppPrismaClient } from "@/lib/db"
import { isPermissionError, resolveWorkspaceAdmin } from "@/lib/permissions"
import type { ResolveContext } from "./resolvers/context"

export type HomeRouteParams = { params: Promise<{ orgSlug: string; workspaceSlug: string }> }

export interface HomeAdminContext {
  prisma: AppPrismaClient
  workspaceId: string
  userId: string
  resolveContext: Omit<ResolveContext, "isWorkspaceMember">
}

/**
 * Every Portal Home admin route goes through here: workspace-admin authorization
 * (the same resolveWorkspaceAdmin the settings actions use, so org admins pass
 * and plain members and non-members do not), then Zod/permission error mapping.
 * Nothing in /api/portal-home is reachable by a portal (customer) session.
 */
export async function withHomeAdmin(
  { params }: HomeRouteParams,
  handler: (ctx: HomeAdminContext) => Promise<Response>,
): Promise<Response> {
  try {
    const { orgSlug, workspaceSlug } = await params
    const { workspaceId } = await resolveWorkspaceAdmin(orgSlug, workspaceSlug)
    const session = await auth()
    const prisma = getPrisma()
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, roadmapPublic: true, feedbackEnabled: true },
    })
    if (!workspace || !session?.user?.id) return NextResponse.json({ error: "Workspace not found" }, { status: 404 })
    return await handler({
      prisma,
      workspaceId,
      userId: session.user.id,
      resolveContext: {
        prisma,
        workspace: {
          id: workspace.id,
          orgSlug,
          workspaceSlug,
          roadmapPublic: workspace.roadmapPublic === true,
          feedbackEnabled: workspace.feedbackEnabled === true,
        },
      },
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export function errorResponse(error: unknown): Response {
  if (isPermissionError(error)) {
    const status = error.message === "Unauthorized" ? 401 : error.message === "Workspace not found" ? 404 : 403
    return NextResponse.json({ error: error.message }, { status })
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: "Invalid request", issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
      { status: 400 },
    )
  }
  if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  console.error("Unexpected portal-home route error", error)
  return NextResponse.json({ error: "Internal server error" }, { status: 500 })
}
