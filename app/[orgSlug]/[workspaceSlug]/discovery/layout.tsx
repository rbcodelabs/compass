import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { DiscoveryShell } from "@/components/discovery/discovery-shell";
import type { DiscoveryRailOpportunity } from "@/components/discovery/discovery-rail";
import type { OpportunityStatus, SquadData } from "@/lib/types";

interface DiscoveryLayoutProps {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export default async function DiscoveryLayout({ children, params }: DiscoveryLayoutProps) {
  const session = await auth();
  if (!session) redirect("/login");

  const { orgSlug, workspaceSlug } = await params;
  const prisma = getPrisma();

  const workspace = await prisma.workspace.findFirst({
    where: {
      slug: workspaceSlug,
      organization: { slug: orgSlug },
    },
    select: { id: true },
  });

  if (!workspace) notFound();

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

  const squads: SquadData[] = rawSquads.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
  }));

  const squadMap = new Map(squads.map((s) => [s.id, s]));

  const opportunities: DiscoveryRailOpportunity[] = rawOpportunities.map((o) => ({
    id: o.id,
    title: o.title,
    status: o.status as OpportunityStatus,
    squad: o.squadId ? (squadMap.get(o.squadId) ?? null) : null,
    linkedKeyResultId: o.linkedKeyResultId,
  }));

  return (
    <DiscoveryShell
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      workspaceId={workspace.id}
      opportunities={opportunities}
      squads={squads}
    >
      {children}
    </DiscoveryShell>
  );
}
