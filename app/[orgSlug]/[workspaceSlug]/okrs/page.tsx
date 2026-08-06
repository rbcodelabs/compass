import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import getPrisma from "@/lib/db";
import { CycleCard } from "@/components/okrs/cycle-card";
import { CreateCycleForm } from "@/components/okrs/create-cycle-form";
import { Target } from "lucide-react";
import type { CycleStatus } from "@/lib/types";
import { EmptyState, PageHeader } from "@/components/patterns";

export const metadata = {
  title: "OKRs",
};

interface OKRsPageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
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

  return (
    <main className="flex flex-col flex-1 p-4 sm:p-6 md:p-8 gap-8">
      <PageHeader title="OKRs" description="Track objectives and key results across cycles." actions={<CreateCycleForm
          workspaceId={workspace.id}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
        />} />

      {cycles.length === 0 ? (
        <EmptyState icon={<Target className="size-6" />} title="No OKR cycles yet" description="Cycles group your objectives into time-boxed periods. Create one to start setting goals." primaryAction={<CreateCycleForm
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
