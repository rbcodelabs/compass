import { Suspense } from "react";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import getPrisma from "@/lib/db";
import { ObjectiveRow } from "@/components/okrs/objective-row";
import { AddObjectiveForm } from "@/components/okrs/add-objective-form";
import { SquadFilterBar } from "@/components/squads/squad-filter-bar";
import type {
  CycleStatus,
  ObjectiveStatus,
  CustomFieldDefinitionData,
  CustomFieldType,
  CustomFieldValue,
  SquadData,
} from "@/lib/types";

export const metadata = {
  title: "OKR Cycle",
};

interface CyclePageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string; cycleId: string }>;
  searchParams: Promise<{ squad?: string }>;
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

export default async function CyclePage({ params, searchParams }: CyclePageProps) {
  const session = await auth();
  if (!session) redirect("/login");

  const { orgSlug, workspaceSlug, cycleId } = await params;
  const { squad: squadFilter } = await searchParams;
  const prisma = getPrisma();

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

  const [rawSquads, objectives] = await Promise.all([
    prisma.squad.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "asc" },
    }),
    prisma.objective.findMany({
      where: {
        cycleId: cycle.id,
        ...(squadFilter ? { squadId: squadFilter } : {}),
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const squads: SquadData[] = rawSquads.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
  }));

  const squadMap = new Map(squads.map((s) => [s.id, s]));

  const objectiveIds = objectives.map((o) => o.id);
  const keyResults =
    objectiveIds.length > 0
      ? await prisma.keyResult.findMany({
          where: { objectiveId: { in: objectiveIds } },
          orderBy: { createdAt: "asc" },
        })
      : [];

  const krByObjective = keyResults.reduce<Record<string, typeof keyResults>>(
    (acc, kr) => {
      (acc[kr.objectiveId] ??= []).push(kr);
      return acc;
    },
    {}
  );

  // Custom fields for OBJECTIVE
  const objFieldDefs = await prisma.customFieldDefinition.findMany({
    where: { workspaceId: workspace.id, objectType: "OBJECTIVE" },
    orderBy: { order: "asc" },
  });

  const objFieldValues =
    objFieldDefs.length > 0 && objectiveIds.length > 0
      ? await prisma.customFieldValue.findMany({
          where: {
            fieldId: { in: objFieldDefs.map((f) => f.id) },
            objectId: { in: objectiveIds },
          },
        })
      : [];

  // Build a map: objectiveId → field values
  const objValuesByObjectiveId = objFieldValues.reduce<
    Map<string, Map<string, unknown>>
  >((acc, v) => {
    if (!acc.has(v.objectId)) acc.set(v.objectId, new Map());
    acc.get(v.objectId)!.set(v.fieldId, v.value);
    return acc;
  }, new Map());

  const objectivesWithData = objectives.map((obj) => {
    const valMap = objValuesByObjectiveId.get(obj.id) ?? new Map();
    const customFields: Array<CustomFieldDefinitionData & { currentValue: CustomFieldValue }> =
      objFieldDefs.map((f) => ({
        id: f.id,
        name: f.name,
        fieldType: f.fieldType as CustomFieldType,
        objectType: "OBJECTIVE" as const,
        options: f.options as CustomFieldDefinitionData["options"],
        required: f.required,
        order: f.order,
        currentValue: (valMap.get(f.id) ?? null) as CustomFieldValue,
      }));

    return {
      ...obj,
      status: obj.status as ObjectiveStatus,
      keyResults: krByObjective[obj.id] ?? [],
      customFields,
      squad: obj.squadId ? (squadMap.get(obj.squadId) ?? null) : null,
    };
  });

  // Flat list of all KRs in this cycle, carrying their objective title for display.
  const allKRsInCycle = objectivesWithData.flatMap((obj) =>
    obj.keyResults.map((kr) => ({
      id: kr.id,
      title: kr.title,
      objectiveTitle: obj.title,
      objectiveId: obj.id,
    }))
  );

  const cyclePath = `/${orgSlug}/${workspaceSlug}/okrs/${cycleId}`;

  return (
    <main className="flex flex-col flex-1 p-8 gap-6">
      {/* Cycle header */}
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

      <Suspense>
        <SquadFilterBar squads={squads} />
      </Suspense>

      {/* Objectives list + inline add */}
      <div className="flex flex-col gap-4">
        {objectivesWithData.map((obj) => (
          <ObjectiveRow
            key={obj.id}
            objective={obj}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            revalidatePathStr={cyclePath}
            availableKRs={allKRsInCycle.filter(
              (kr) => kr.objectiveId !== obj.id
            )}
            parentKeyResultId={
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (obj as any).parentKeyResultId ?? null
            }
          />
        ))}

        <AddObjectiveForm
          cycleId={cycle.id}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          squads={squads}
        />
      </div>
    </main>
  );
}
