import { NextResponse } from "next/server";
import getPrisma from "@/lib/db";
import { getWorkspaceContext } from "@/lib/workspace-context";
import { getLinkedObjectivesByOpportunity } from "@/lib/typed-links";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const orgSlug = searchParams.get("orgSlug");
  const workspaceSlug = searchParams.get("workspaceSlug");

  if (!orgSlug || !workspaceSlug) {
    return NextResponse.json({ error: "Missing orgSlug or workspaceSlug" }, { status: 400 });
  }

  // The shared resolver checks the session AND workspace membership in one
  // lookup. A missing workspace and a workspace the caller is not a member of
  // are deliberately indistinguishable (both 404).
  const context = await getWorkspaceContext(orgSlug, workspaceSlug);
  if (context.status === "unauthenticated") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (context.status === "not-found") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const workspace = { id: context.workspace.id };

  const prisma = getPrisma();

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

  // Additive typed links, one workspace-filtered batch for the whole rail.
  const linkedObjectives = await getLinkedObjectivesByOpportunity(prisma, workspace.id, rawOpportunities.map((o) => o.id));

  const opportunities = rawOpportunities.map((o) => ({
    id: o.id,
    title: o.title,
    status: o.status,
    squad: o.squadId ? (squadMap.get(o.squadId) ?? null) : null,
    linkedKeyResultId: o.linkedKeyResultId,
    linkedObjectives: linkedObjectives.get(o.id) ?? [],
  }));

  return NextResponse.json({ workspaceId: workspace.id, opportunities, squads });
}
