import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import getPrisma from "@/lib/db";
import { ObjectiveRow } from "@/components/okrs/objective-row";
import { AddObjectiveForm } from "@/components/okrs/add-objective-form";
import type { CycleStatus, ObjectiveStatus } from "@/lib/types";

export const metadata = {
  title: "OKR Cycle",
};

interface CyclePageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string; cycleId: string }>;
}

const CYCLE_STATUS_STYLES: Record<CycleStatus, string> = {
  ACTIVE: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  DRAFT: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  CLOSED: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
};

const CYCLE_STATUS_LABELS: Record<CycleStatus, string> = {
  ACTIVE: "Active",
  DRAFT: "Draft",
  CLOSED: "Closed",
};

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default async function CyclePage({ params }: CyclePageProps) {
  const session = await auth();
  if (!session) redirect("/login");

  const { orgSlug, workspaceSlug, cycleId } = await params;
  const prisma = getPrisma();

  // Verify the cycle belongs to the right workspace/org
  const workspace = await prisma.workspace.findFirst({
    where: {
      slug: workspaceSlug,
      organization: { slug: orgSlug },
    },
  });

  if (!workspace) notFound();

  const cycle = await prisma.oKRCycle.findFirst({
    where: { id: cycleId, workspaceId: workspace.id },
  });

  if (!cycle) notFound();

  const cycleStatus = cycle.status as CycleStatus;

  // Fetch objectives for this cycle
  const objectives = await prisma.objective.findMany({
    where: { cycleId: cycle.id },
    orderBy: { createdAt: "asc" },
  });

  // Fetch all key results for these objectives in one query
  const objectiveIds = objectives.map((o) => o.id);
  const keyResults =
    objectiveIds.length > 0
      ? await prisma.keyResult.findMany({
          where: { objectiveId: { in: objectiveIds } },
          orderBy: { createdAt: "asc" },
        })
      : [];

  // Group key results by objectiveId
  const krByObjective = keyResults.reduce<Record<string, typeof keyResults>>(
    (acc, kr) => {
      (acc[kr.objectiveId] ??= []).push(kr);
      return acc;
    },
    {}
  );

  const objectivesWithKRs = objectives.map((obj) => ({
    ...obj,
    status: obj.status as ObjectiveStatus,
    keyResults: krByObjective[obj.id] ?? [],
  }));

  return (
    <main className="flex flex-col flex-1 p-8 gap-6">
      {/* Cycle header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {cycle.title}
            </h1>
            <span
              className={`inline-flex h-5 shrink-0 items-center rounded-full px-2 text-xs font-medium ${CYCLE_STATUS_STYLES[cycleStatus]}`}
            >
              {CYCLE_STATUS_LABELS[cycleStatus]}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            {formatDate(cycle.startDate)} – {formatDate(cycle.endDate)}
          </p>
        </div>

        <AddObjectiveForm
          cycleId={cycle.id}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
        />
      </div>

      {/* Objectives list */}
      {objectivesWithKRs.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-3 text-center py-16">
          <p className="text-muted-foreground">No objectives yet.</p>
          <p className="text-sm text-muted-foreground">
            Add your first objective to start tracking key results.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {objectivesWithKRs.map((obj) => (
            <ObjectiveRow
              key={obj.id}
              objective={obj}
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
            />
          ))}
        </div>
      )}
    </main>
  );
}
