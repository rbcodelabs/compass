import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import getPrisma from "@/lib/db";
import { CycleCard } from "@/components/okrs/cycle-card";
import { CreateCycleDialog } from "@/components/okrs/create-cycle-dialog";

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
  const prisma = await getPrisma();

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
    <main className="flex flex-col flex-1 p-8 gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">OKRs</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Track objectives and key results across cycles.
          </p>
        </div>
        <CreateCycleDialog
          workspaceId={workspace.id}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
        />
      </div>

      {cycles.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-3 text-center py-16">
          <p className="text-muted-foreground">No OKR cycles yet.</p>
          <p className="text-sm text-muted-foreground">
            Create your first cycle to start tracking objectives.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {cycles.map((cycle) => (
            <CycleCard
              key={cycle.id}
              cycle={cycle}
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
            />
          ))}
        </div>
      )}
    </main>
  );
}
