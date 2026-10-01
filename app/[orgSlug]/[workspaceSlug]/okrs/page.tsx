import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import getPrisma from "@/lib/db";
import { CycleCard } from "@/components/okrs/cycle-card";
import { CreateCycleForm } from "@/components/okrs/create-cycle-form";
import { Target } from "lucide-react";
import type { CycleStatus } from "@/lib/types";
import { EmptyState, PageHeader } from "@/components/patterns";
import { resolveThinkingModel } from "@/lib/thinking-model/resolve";
import { getThinkingModelForSlugs } from "@/lib/thinking-model/server";

interface OKRsPageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export async function generateMetadata({ params }: OKRsPageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const { labels } = await getThinkingModelForSlugs(orgSlug, workspaceSlug);
  return { title: labels.sections.okrs };
}

export default async function OKRsPage({ params }: OKRsPageProps) {
  const session = await auth();
  if (!session) redirect("/login");

  const { orgSlug, workspaceSlug } = await params;
  const prisma = getPrisma();

  // Resolve workspace by slug + org slug
  const workspace = await prisma.workspace.findFirst({
    where: {
      slug: workspaceSlug,
      organization: { slug: orgSlug },
    },
  });

  if (!workspace) notFound();

  const cycles = await prisma.oKRCycle.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { startDate: "desc" },
    include: {
      _count: { select: { objectives: true } },
    },
  });

  const { labels } = resolveThinkingModel(workspace);

  return (
    <main className="flex flex-col flex-1 p-4 sm:p-6 md:p-8 gap-8">
      <PageHeader title={labels.sections.okrs} description={`Track ${labels.objective.lowerPlural} and ${labels.keyResult.lowerPlural} across ${labels.cycle.lowerPlural}.`} actions={<CreateCycleForm
          workspaceId={workspace.id}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
        />} />

      {cycles.length === 0 ? (
        <EmptyState icon={<Target className="size-6" />} title={`No OKR ${labels.cycle.lowerPlural} yet`} description={`${labels.cycle.plural} group your ${labels.objective.lowerPlural} into time-boxed periods. Create one to start setting goals.`} primaryAction={<CreateCycleForm
            workspaceId={workspace.id}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
          />} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {cycles.map((cycle) => (
            <CycleCard
              key={cycle.id}
              cycle={{ ...cycle, status: cycle.status as CycleStatus }}
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
            />
          ))}
        </div>
      )}
    </main>
  );
}
