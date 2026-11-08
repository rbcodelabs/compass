import { NextResponse } from "next/server"
import { publishableDocWhere } from "@/lib/portal-docs/service"
import { withHomeAdmin, type HomeRouteParams } from "@/lib/portal-home/admin-api"

/**
 * Admin: pickers for widget config. Roadmap items include PRIVATE ones (flagged
 * isPrivate) because the team home shows them. Customers still never receive a
 * private pinned item: the customer resolver re-applies the public predicate
 * server-side whatever was pinned. Docs are workspace members' own; only publishable ones are offered (no canvas, no externally stored).
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
        where: publishableDocWhere(workspaceId),
        orderBy: [{ updatedAt: "desc" }],
        take: 200,
        select: { id: true, title: true, publishedAt: true },
      }),
    ])
    // isPublished lets the Docs widget picker flag docs customers cannot see yet. The timestamp itself stays server-side.
    return NextResponse.json({
      roadmapItems,
      docs: docs.map((doc) => ({ id: doc.id, title: doc.title, isPublished: doc.publishedAt !== null })),
    })
  })
}
