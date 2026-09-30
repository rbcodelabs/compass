import { Suspense } from "react";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import getPrisma from "@/lib/db";
import { ObjectivesList } from "@/components/okrs/objectives-list";
import { AddObjectiveForm } from "@/components/okrs/add-objective-form";
import { SquadFilterBar } from "@/components/squads/squad-filter-bar";
import {
  getEligibleParentKeyResults,
  getEligibleSupportingObjectives,
} from "@/lib/okr-hierarchy";
import type {
  CycleStatus,
  ObjectiveStatus,
  CustomFieldDefinitionData,
  CustomFieldType,
  CustomFieldValue,
  SquadData,
} from "@/lib/types";
import { PageHeader, StatusBadge } from "@/components/patterns";
import { toCustomFieldDefinitionData } from "@/lib/custom-field-definitions";
import {
  NO_CYCLE_LABEL,
  PERSISTENT_CYCLE_SLUG,
  cycleRefOrPersistent,
  cycleRouteSegment,
} from "@/lib/okr-cycle-scope";

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

  // "none" is the fixed route for Objectives that have no cycle (migration 069).
  const isPersistent = cycleId === PERSISTENT_CYCLE_SLUG;
  const cycle = isPersistent
    ? null
    : await prisma.oKRCycle.findFirst({
        where: { id: cycleId, workspaceId: workspace.id },
      });

  if (!isPersistent && !cycle) notFound();

  const cycleStatus = cycle ? (cycle.status as CycleStatus) : null;

  const [rawSquads, objectives, eligibleParentKRs, eligibleSupportingObjectives] = await Promise.all([
    prisma.squad.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "asc" },
    }),
    prisma.objective.findMany({
      where: {
        cycleId: cycle?.id ?? null,
        workspaceId: workspace.id,
        ...(squadFilter ? { squadId: squadFilter } : {}),
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    }),
    getEligibleParentKeyResults(workspace.id, cycle?.id ?? null),
    getEligibleSupportingObjectives(workspace.id, cycle?.id ?? null),
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
    include: { sharedOptionSet: { select: { id: true, name: true, options: true } } },
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
        ...toCustomFieldDefinitionData(f),
        objectType: "OBJECTIVE" as const,
        currentValue: (valMap.get(f.id) ?? null) as CustomFieldValue,
      }));

    return {
      ...obj,
      status: obj.status as ObjectiveStatus,
      keyResults: (krByObjective[obj.id] ?? []).map((kr) => ({
        ...kr,
        supportingObjectives: kr.supportingObjectives.map((supporting) => ({
          ...supporting,
          cycle: cycleRefOrPersistent(supporting.cycle),
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
          objective: { workspaceId: workspace.id },
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
      objectiveId: kr.objectiveId,
      cycleId: kr.cycleId,
      cycleTitle: kr.cycleTitle,
      cycleStatus: kr.cycleStatus,
    })),
    ...currentParentKRs.map((kr) => ({
      id: kr.id,
      title: kr.title,
      objectiveTitle: kr.objective.title,
      objectiveId: kr.objective.id,
      cycleId: kr.objective.cycle?.id ?? null,
      cycleTitle: kr.objective.cycle?.title ?? NO_CYCLE_LABEL,
      cycleStatus: kr.objective.cycle?.status ?? null,
    })),
  ];

  const cyclePath = `/${orgSlug}/${workspaceSlug}/okrs/${cycleId}`;

  return (
    <main className="flex flex-col flex-1 p-4 sm:p-6 md:p-8 gap-6">
      {cycle && cycleStatus ? (
        <PageHeader title={<span className="flex items-center gap-2">{cycle.title}<StatusBadge status={CYCLE_STATUS_TONE[cycleStatus]}>{CYCLE_STATUS_LABELS[cycleStatus]}</StatusBadge></span>} description={`${formatDate(cycle.startDate)} – ${formatDate(cycle.endDate)}`} />
      ) : (
        <PageHeader title={NO_CYCLE_LABEL} description="Objectives that are not tied to a planning period. They can support, and be supported by, Key Results in any open cycle." />
      )}

      <Suspense>
        <SquadFilterBar squads={squads} />
      </Suspense>

      {/* Objectives list + inline add */}
      <div className="flex flex-col gap-4">
        <ObjectivesList
          key={objectivesWithData
            .map((o) => `${o.id}:${o.parentKeyResultId ?? ""}`)
            .join(",")}
          objectives={objectivesWithData.map((obj) => ({
            ...obj,
            parentKeyResultId: obj.parentKeyResultId ?? null,
          }))}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          cyclePath={cyclePath}
          availableKRs={parentKROptions}
          supportingObjectiveOptions={eligibleSupportingObjectives.map((objective) => ({
            id: objective.id,
            title: objective.title,
            cycleId: cycleRouteSegment(objective.cycleId),
            cycleTitle: objective.cycleTitle,
          }))}
        />

        <AddObjectiveForm
          cycleId={cycle?.id ?? null}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          squads={squads}
        />
      </div>
    </main>
  );
}
