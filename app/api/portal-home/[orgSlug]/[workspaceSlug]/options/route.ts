import { NextResponse } from "next/server"
import { publishableDocWhere } from "@/lib/portal-docs/service"
import { withHomeAdmin, type HomeRouteParams } from "@/lib/portal-home/admin-api"

/**
 * Admin: pickers for widget config. Roadmap items include PRIVATE ones (flagged
 * isPrivate) because the team home shows them. Customers still never receive a
 * private pinned item: the customer resolver re-applies the public predicate
 * server-side whatever was pinned. Docs are workspace members' own; only publishable ones are offered (no canvas, no externally stored).
 */
export async function GET(req: Request, route: HomeRouteParams) {
  return withHomeAdmin(route, async ({ prisma, workspaceId }) => {
    if (new URL(req.url).searchParams.get("audience") === "team") {
      const [artifacts, okrCycles, objectives] = await Promise.all([
        prisma.artifact.findMany({
          where: { workspaceId, status: "ACTIVE" },
          orderBy: [{ updatedAt: "desc" }],
          take: 200,
          select: { id: true, title: true, kind: true, sourceType: true },
        }),
        prisma.oKRCycle.findMany({
          where: { workspaceId },
          orderBy: [{ startDate: "desc" }],
          take: 50,
          select: { id: true, title: true, status: true },
        }),
        prisma.objective.findMany({
          where: { workspaceId },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          take: 200,
          select: { id: true, title: true, cycleId: true },
        }),
      ])
      const cycleTitles = new Map(okrCycles.map(({ id, title }) => [id, title]))
      const additionalIds = [...new Set(objectives.flatMap(({ cycleId }) => cycleId && !cycleTitles.has(cycleId) ? [cycleId] : []))]
      if (additionalIds.length > 0) {
        const additionalCycles = await prisma.oKRCycle.findMany({
          where: { workspaceId, id: { in: additionalIds } },
          select: { id: true, title: true },
        })
        for (const { id, title } of additionalCycles) cycleTitles.set(id, title)
      }
      return NextResponse.json({
        roadmapItems: [],
        docs: [],
        artifacts,
        okrCycles,
        objectives: objectives.map((objective) => ({ id: objective.id, title: objective.title, cycleTitle: objective.cycleId ? cycleTitles.get(objective.cycleId) ?? null : null })),
      })
    }

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
    // The timestamp stays server-side. The picker only needs to know whether the doc is published.
    return NextResponse.json({
      roadmapItems,
      docs: docs.map((doc) => ({ id: doc.id, title: doc.title, isPublished: doc.publishedAt !== null })),
    })
  })
}
