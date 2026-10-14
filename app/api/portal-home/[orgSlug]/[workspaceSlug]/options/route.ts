import { NextResponse } from "next/server"
import { withHomeAdmin, type HomeRouteParams } from "@/lib/portal-home/admin-api"

/**
 * Admin: pickers for widget config. Roadmap items include PRIVATE ones (flagged
 * isPrivate) because the team home shows them. Customers still never receive a
 * private pinned item: the customer resolver re-applies the public predicate
 * server-side whatever was pinned. Docs are workspace members' own.
 */
export async function GET(_req: Request, route: HomeRouteParams) {
  return withHomeAdmin(route, async ({ prisma, workspaceId }) => {
    const [roadmapItems, docs] = await Promise.all([
      prisma.roadmapItem.findMany({
        where: { workspaceId, status: { not: "ARCHIVED" } },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        take: 200,
        select: { id: true, title: true, horizon: true, isPrivate: true },
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
