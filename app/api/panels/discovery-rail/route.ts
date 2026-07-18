import { NextResponse } from "next/server";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const orgSlug = searchParams.get("orgSlug");
  const workspaceSlug = searchParams.get("workspaceSlug");

  if (!orgSlug || !workspaceSlug) {
    return NextResponse.json({ error: "Missing orgSlug or workspaceSlug" }, { status: 400 });
  }

  const prisma = getPrisma();

  const workspace = await prisma.workspace.findFirst({
    where: {
      slug: workspaceSlug,
      organization: { slug: orgSlug },
    },
    select: { id: true },
  });

  if (!workspace) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [rawOpportunities, rawSquads] = await Promise.all([
    prisma.opportunity.findMany({
      where: { workspaceId: workspace.id },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        title: true,
        status: true,
        squadId: true,
        linkedKeyResultId: true,
      },
    }),
    prisma.squad.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const squads = rawSquads.map((s) => ({ id: s.id, name: s.name, color: s.color }));
  const squadMap = new Map(squads.map((s) => [s.id, s]));

  const opportunities = rawOpportunities.map((o) => ({
    id: o.id,
    title: o.title,
    status: o.status,
    squad: o.squadId ? (squadMap.get(o.squadId) ?? null) : null,
    linkedKeyResultId: o.linkedKeyResultId,
  }));

  return NextResponse.json({ workspaceId: workspace.id, opportunities, squads });
}
