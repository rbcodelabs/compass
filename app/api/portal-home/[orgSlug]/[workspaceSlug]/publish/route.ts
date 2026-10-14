import { NextResponse } from "next/server"
import { withHomeAdmin, type HomeRouteParams } from "@/lib/portal-home/admin-api"
import { NothingToPublishError, publishDraft } from "@/lib/portal-home/service"

/** Admin: copy the saved draft to published. */
export async function POST(_req: Request, route: HomeRouteParams) {
  return withHomeAdmin(route, async ({ prisma, workspaceId, userId }) => {
    try {
      const { published, publishedAt } = await publishDraft(prisma, workspaceId, userId)
      return NextResponse.json({ published, publishedAt: publishedAt.toISOString(), hasUnpublishedChanges: false })
    } catch (error) {
      if (error instanceof NothingToPublishError) return NextResponse.json({ error: error.message }, { status: 409 })
      throw error
    }
  })
}
