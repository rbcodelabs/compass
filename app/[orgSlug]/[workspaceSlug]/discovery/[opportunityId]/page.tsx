import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ChevronLeftIcon } from "lucide-react";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SolutionCard } from "@/components/discovery/solution-card";
import { AddSolutionForm } from "@/components/discovery/add-solution-form";
import { OpportunityOverview } from "@/components/discovery/opportunity-overview";
import { OpportunityExperimentsTab } from "@/components/discovery/opportunity-experiments-tab";
import type { ExperimentRef } from "@/components/discovery/opportunity-experiments-tab";
import type {
  OpportunityStatus,
  SolutionStatus,
  AssumptionStatus,
  RiskLevel,
  CustomFieldDefinitionData,
  CustomFieldType,
  CustomFieldValue,
  SquadData,
} from "@/lib/types";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string; opportunityId: string }>;
}) {
  const { opportunityId } = await params;
  const prisma = getPrisma();
  const opp = await prisma.opportunity.findUnique({
    where: { id: opportunityId },
    select: { title: true },
  });
  return { title: opp?.title ?? "Opportunity" };
}

type Props = {
  params: Promise<{
    orgSlug: string;
    workspaceSlug: string;
    opportunityId: string;
  }>;
};

export default async function OpportunityDetailPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { orgSlug, workspaceSlug, opportunityId } = await params;
  const prisma = getPrisma();

  // Resolve workspace
  const workspace = await prisma.workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug } },
    select: { id: true },
  });
  if (!workspace) notFound();

  const [opportunity, rawSquads] = await Promise.all([
    prisma.opportunity.findFirst({
      where: {
        id: opportunityId,
        workspace: {
          slug: workspaceSlug,
          organization: { slug: orgSlug },
        },
      },
      include: {
        linkedKeyResult: {
          select: {
            id: true,
            title: true,
            objective: { select: { title: true } },
          },
        },
        solutions: {
          orderBy: { createdAt: "asc" },
          include: {
            assumptions: {
              orderBy: { createdAt: "asc" },
              include: {
                experiments: {
                  select: {
                    id: true,
                    title: true,
                    status: true,
                    conclusion: true,
                    hypothesis: true,
                    startDate: true,
                    endDate: true,
                  },
                  orderBy: { createdAt: "desc" },
                },
              },
            },
          },
        },
      },
    }),
    prisma.squad.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  if (!opportunity) notFound();

  const squads: SquadData[] = rawSquads.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
  }));

  // Fetch available key results for this workspace (to power the KR link picker)
  const allKRs = await prisma.keyResult.findMany({
    where: {
      objective: {
        cycle: { workspaceId: workspace.id },
      },
    },
    select: {
      id: true,
      title: true,
      objective: { select: { title: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const availableKeyResults = allKRs.map((kr) => ({
    id: kr.id,
    title: kr.title,
    objectiveTitle: kr.objective.title,
  }));

  // Fetch custom field definitions for OPPORTUNITY
  const fieldDefs = await prisma.customFieldDefinition.findMany({
    where: { workspaceId: workspace.id, objectType: "OPPORTUNITY" },
    orderBy: { order: "asc" },
  });

  // Fetch values for this opportunity
  const fieldValues = fieldDefs.length > 0
    ? await prisma.customFieldValue.findMany({
        where: {
          fieldId: { in: fieldDefs.map((f) => f.id) },
          objectId: opportunityId,
        },
      })
    : [];

  const valueByFieldId = new Map(fieldValues.map((v) => [v.fieldId, v.value]));

  const customFields: Array<CustomFieldDefinitionData & { currentValue: CustomFieldValue }> =
    fieldDefs.map((f) => ({
      id: f.id,
      name: f.name,
      fieldType: f.fieldType as CustomFieldType,
      objectType: "OPPORTUNITY" as const,
      options: f.options as CustomFieldDefinitionData["options"],
      required: f.required,
      order: f.order,
      currentValue: (valueByFieldId.get(f.id) ?? null) as CustomFieldValue,
    }));

  // Flatten all experiments across solutions/assumptions, attaching assumptionTitle.
  const allExperiments: ExperimentRef[] = opportunity.solutions.flatMap((sol) =>
    sol.assumptions.flatMap((assumption) =>
      assumption.experiments.map((exp) => ({
        ...exp,
        assumptionTitle: assumption.title,
      }))
    )
  );
  const experimentCount = allExperiments.length;

  const boardPath = `/${orgSlug}/${workspaceSlug}/discovery`;
  const detailPath = `/${orgSlug}/${workspaceSlug}/discovery/${opportunityId}`;

  return (
    <main className="flex flex-col flex-1 p-6 gap-6 min-w-0 max-w-4xl">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link
          href={boardPath}
          className="flex items-center gap-1 hover:text-foreground transition-colors"
        >
          <ChevronLeftIcon className="size-4" />
          Discovery
        </Link>
      </div>

      <div>
        <h1 className="text-xl font-semibold tracking-tight">{opportunity.title}</h1>
        {opportunity.customerSegment && (
          <p className="text-sm text-muted-foreground mt-0.5">
            {opportunity.customerSegment}
          </p>
        )}
      </div>

      <Tabs defaultValue="solutions">
        <TabsList>
          <TabsTrigger value="solutions">
            Solutions ({opportunity.solutions.length})
          </TabsTrigger>
          <TabsTrigger value="experiments">
            Experiments ({experimentCount})
          </TabsTrigger>
          <TabsTrigger value="overview">Overview</TabsTrigger>
        </TabsList>

        <TabsContent value="solutions" className="flex flex-col gap-3 pt-4">
          {opportunity.solutions.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No solutions yet. Add one below.
            </p>
          )}
          {opportunity.solutions.map((solution) => (
            <SolutionCard
              key={solution.id}
              solution={{
                ...solution,
                status: solution.status as SolutionStatus,
                assumptions: solution.assumptions.map((a) => ({
                  ...a,
                  riskLevel: a.riskLevel as RiskLevel,
                  status: a.status as AssumptionStatus,
                })),
              }}
              revalidatePathStr={detailPath}
              workspaceId={workspace.id}
              opportunityId={opportunityId}
              squadId={opportunity.squadId}
            />
          ))}
          <AddSolutionForm
            opportunityId={opportunityId}
            revalidatePathStr={detailPath}
          />
        </TabsContent>

        <TabsContent value="experiments" className="pt-4">
          <OpportunityExperimentsTab
            experiments={allExperiments}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
          />
        </TabsContent>

        <TabsContent value="overview" className="pt-4">
          <OpportunityOverview
            opportunity={{ ...opportunity, status: opportunity.status as OpportunityStatus }}
            revalidatePathStr={detailPath}
            availableKeyResults={availableKeyResults}
            customFields={customFields}
            squads={squads}
            currentSquadId={opportunity.squadId}
          />
        </TabsContent>
      </Tabs>
    </main>
  );
}
