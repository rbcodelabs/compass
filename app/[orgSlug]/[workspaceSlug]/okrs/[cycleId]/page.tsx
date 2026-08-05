import { Suspense } from "react";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import getPrisma from "@/lib/db";
import { ObjectivesList } from "@/components/okrs/objectives-list";
import { AddObjectiveForm } from "@/components/okrs/add-objective-form";
import { SquadFilterBar } from "@/components/squads/squad-filter-bar";
import { getEligibleParentKeyResults } from "@/lib/okr-hierarchy";
import type {
  CycleStatus,
  ObjectiveStatus,
  CustomFieldDefinitionData,
  CustomFieldType,
  CustomFieldValue,
  SquadData,
} from "@/lib/types";
import { PageHeader, StatusBadge } from "@/components/patterns";

export const metadata = {
  title: "OKR Cycle",
};

interface CyclePageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string; cycleId: string }>;
  searchParams: Promise<{ squad?: string }>;
}

const CYCLE_STATUS_TONE: Record<CycleStatus, "success" | "neutral"> = {
  ACTIVE: "success", DRAFT: "neutral", CLOSED: "neutral",
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

  const [rawSquads, objectives, eligibleParentKRs] = await Promise.all([
    prisma.squad.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "asc" },
    }),
    prisma.objective.findMany({
      where: {
        cycleId: cycle.id,
        ...(squadFilter ? { squadId: squadFilter } : {}),
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    }),
    getEligibleParentKeyResults(workspace.id, cycle.id),
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
          include: {
            supportingObjectives: {
              include: {
                cycle: { select: { id: true, title: true } },
                squad: { select: { id: true, name: true, color: true } },
                keyResults: {
                  select: { current: true, target: true },
                  orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
                },
              },
              orderBy: [{ cycle: { startDate: "asc" } }, { sortOrder: "asc" }],
            },
          },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
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
      keyResults: (krByObjective[obj.id] ?? []).map((kr) => ({
        ...kr,
        supportingObjectives: kr.supportingObjectives.map((supporting) => ({
          ...supporting,
          status: supporting.status as ObjectiveStatus,
        })),
      })),
      customFields,
      squad: obj.squadId ? (squadMap.get(obj.squadId) ?? null) : null,
    };
  });

  // Eligible longer-horizon KRs plus any existing parent that has since been
  // closed. Existing historical links remain readable, but closed cycles are
  // not offered for new relationships.
  const currentParentIds = [...new Set(objectives.flatMap((obj) =>
    obj.parentKeyResultId ? [obj.parentKeyResultId] : []
  ))];
  const eligibleIds = new Set(eligibleParentKRs.map((kr) => kr.id));
  const missingCurrentParents = currentParentIds.filter((id) => !eligibleIds.has(id));
  const currentParentKRs = missingCurrentParents.length
    ? await prisma.keyResult.findMany({
        where: {
          id: { in: missingCurrentParents },
          objective: { cycle: { workspaceId: workspace.id } },
        },
        include: {
          objective: {
            include: { cycle: true },
          },
        },
      })
    : [];
  const parentKROptions = [
    ...eligibleParentKRs.map((kr) => ({
      id: kr.id,
      title: kr.title,
      objectiveTitle: kr.objectiveTitle,
      cycleId: kr.cycleId,
      cycleTitle: kr.cycleTitle,
      cycleStatus: kr.cycleStatus,
    })),
    ...currentParentKRs.map((kr) => ({
      id: kr.id,
      title: kr.title,
      objectiveTitle: kr.objective.title,
      cycleId: kr.objective.cycle.id,
      cycleTitle: kr.objective.cycle.title,
      cycleStatus: kr.objective.cycle.status,
    })),
  ];

  const cyclePath = `/${orgSlug}/${workspaceSlug}/okrs/${cycleId}`;

  return (
    <main className="flex flex-col flex-1 p-4 sm:p-6 md:p-8 gap-6">
      <PageHeader title={<span className="flex items-center gap-2">{cycle.title}<StatusBadge status={CYCLE_STATUS_TONE[cycleStatus]}>{CYCLE_STATUS_LABELS[cycleStatus]}</StatusBadge></span>} description={`${formatDate(cycle.startDate)} – ${formatDate(cycle.endDate)}`} />

      <Suspense>
        <SquadFilterBar squads={squads} />
      </Suspense>

      {/* Objectives list + inline add */}
      <div className="flex flex-col gap-4">
        <ObjectivesList
          key={objectivesWithData.map((o) => o.id).join(",")}
          objectives={objectivesWithData.map((obj) => ({
            ...obj,
            parentKeyResultId: obj.parentKeyResultId ?? null,
          }))}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          cyclePath={cyclePath}
          availableKRs={parentKROptions}
        />

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
