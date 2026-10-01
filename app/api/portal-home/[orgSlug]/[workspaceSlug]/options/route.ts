import { NextResponse } from "next/server"
import { withHomeAdmin, type HomeRouteParams } from "@/lib/portal-home/admin-api"
import { publicRoadmapItemWhere } from "@/lib/portal-home/resolvers/context"

/**
 * Admin: pickers for widget config. Roadmap items are limited to PUBLIC ones, so
 * the editor cannot even offer a private item for pinning (the resolver
 * re-checks regardless). Docs are workspace members' own.
 */
export async function GET(_req: Request, route: HomeRouteParams) {
  return withHomeAdmin(route, async ({ prisma, workspaceId }) => {
    const [roadmapItems, docs] = await Promise.all([
      prisma.roadmapItem.findMany({
        where: publicRoadmapItemWhere(workspaceId),
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        take: 200,
        select: { id: true, title: true, horizon: true },
      }),
      prisma.doc.findMany({
        where: { workspaceId },
        orderBy: [{ updatedAt: "desc" }],
        take: 200,
        select: { id: true, title: true },
      }),
    ])
    return NextResponse.json({ roadmapItems, docs })
  })
}
