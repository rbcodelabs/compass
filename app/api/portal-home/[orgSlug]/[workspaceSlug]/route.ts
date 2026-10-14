import { NextResponse } from "next/server"
import { z } from "zod"
import { withHomeAdmin, type HomeRouteParams } from "@/lib/portal-home/admin-api"
import { hasUnpublishedChanges, loadHomeLayout, saveDraft } from "@/lib/portal-home/service"

const putBody = z.object({ widgets: z.unknown() })

/** Admin: the stored draft and published layouts. */
export async function GET(_req: Request, route: HomeRouteParams) {
  return withHomeAdmin(route, async ({ prisma, workspaceId }) => {
    const layout = await loadHomeLayout(prisma, workspaceId)
    return NextResponse.json({
      draft: layout.draft,
      published: layout.published,
      publishedAt: layout.publishedAt?.toISOString() ?? null,
      hasUnpublishedChanges: hasUnpublishedChanges(layout.draft, layout.published),
    })
  })
}

/** Admin: replace the draft. Validated strictly; customers never see a draft. */
export async function PUT(req: Request, route: HomeRouteParams) {
  return withHomeAdmin(route, async ({ prisma, workspaceId }) => {
    const body = putBody.parse(await req.json())
    const draft = await saveDraft(prisma, workspaceId, body.widgets)
    const layout = await loadHomeLayout(prisma, workspaceId)
    return NextResponse.json({
      draft,
      publishedAt: layout.publishedAt?.toISOString() ?? null,
      hasUnpublishedChanges: hasUnpublishedChanges(draft, layout.published),
    })
  })
}
