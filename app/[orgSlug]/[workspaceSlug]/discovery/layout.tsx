import getPrisma from "@/lib/db";
import { requireWorkspaceContext } from "@/lib/workspace-context";
import { DiscoveryShell } from "@/components/discovery/discovery-shell";
import type { DiscoveryRailOpportunity } from "@/components/discovery/discovery-rail";
import type { OpportunityStatus, SquadData } from "@/lib/types";

interface DiscoveryLayoutProps {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export default async function DiscoveryLayout({ children, params }: DiscoveryLayoutProps) {
  const { orgSlug, workspaceSlug } = await params;
  const prisma = getPrisma();

  // Resolves from the request memo — the parent workspace layout already
  // asked for this exact context, so this costs no additional statements.
  //
  // Note this lookup previously omitted the `members: { some: { userId } }`
  // predicate and leaned on the parent workspace layout having already
  // enforced membership. The shared resolver always applies it. That is a
  // tightening, not a behavior change: a nested layout cannot render unless
  // its parent returned, the parent resolves the same slugs membership-scoped
  // and calls notFound(), and there are no parallel/intercepting routes or
  // default.tsx files under app/ that could bypass it.
  const { workspace } = await requireWorkspaceContext(orgSlug, workspaceSlug);

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
