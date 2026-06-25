import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import getPrisma from "@/lib/db";
import { CycleCard } from "@/components/okrs/cycle-card";
import { CreateCycleForm } from "@/components/okrs/create-cycle-form";
import { Target } from "lucide-react";
import type { CycleStatus } from "@/lib/types";

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
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900">OKRs</h1>
          <p className="text-slate-500 text-sm mt-1">
            Track objectives and key results across cycles.
          </p>
        </div>
        <CreateCycleForm
          workspaceId={workspace.id}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
        />
      </div>

      {cycles.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-4 text-center py-20">
          <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center">
            <Target className="w-7 h-7 text-slate-400" />
          </div>
          <div>
            <p className="font-semibold text-slate-800">No OKR cycles yet</p>
            <p className="text-sm text-slate-500 mt-1 max-w-xs mx-auto">
              Cycles group your objectives into time-boxed periods. Create one to start setting goals.
            </p>
          </div>
          <CreateCycleForm
            workspaceId={workspace.id}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
          />
        </div>
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
