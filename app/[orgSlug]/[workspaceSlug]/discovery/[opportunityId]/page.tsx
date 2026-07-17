import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ChevronLeftIcon } from "lucide-react";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SolutionsList } from "@/components/discovery/solutions-list";
import { AddSolutionForm } from "@/components/discovery/add-solution-form";
import { OpportunityHeader } from "@/components/discovery/opportunity-header";
import { OSTTreeView } from "@/components/discovery/ost-tree-view";
import { CustomFieldsPanel } from "@/components/custom-fields/custom-fields-panel";
import { EvidenceList } from "@/components/discovery/evidence-list";
import { AddEvidenceDialog } from "@/components/discovery/add-evidence-dialog";
import type {
  OpportunityStatus,
  SolutionStatus,
  AssumptionStatus,
  RiskLevel,
  ExperimentStatus,
  Conclusion,
  CustomFieldDefinitionData,
  CustomFieldType,
  CustomFieldValue,
  SquadData,
  EvidenceSourceType,
  EvidenceConfidence,
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
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          include: {
            _count: { select: { evidence: true } },
            assumptions: {
              orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
              include: {
                _count: { select: { evidence: true } },
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

  const evidence = await prisma.evidence.findMany({
    where: { opportunityId },
    orderBy: { createdAt: "desc" },
  });

  const squads: SquadData[] = rawSquads.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
  }));

  // Fetch available key results for this workspace
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

  const boardPath = `/${orgSlug}/${workspaceSlug}/discovery`;
  const detailPath = `/${orgSlug}/${workspaceSlug}/discovery/${opportunityId}`;

  const hasCustomFields = customFields.length > 0;

  return (
    <div className="min-h-full p-4 sm:p-6 md:p-8">
      <div className="max-w-4xl mx-auto flex flex-col gap-6">
        {/* Back nav */}
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link
            href={boardPath}
            className="flex items-center gap-1 hover:text-foreground transition-colors"
          >
            <ChevronLeftIcon className="size-4" />
            Discovery
          </Link>
        </div>

        {/* Header — status, title, description, KR, squad */}
        <OpportunityHeader
          opportunity={{
            id: opportunity.id,
            title: opportunity.title,
            description: opportunity.description,
            customerSegment: opportunity.customerSegment,
            status: opportunity.status as OpportunityStatus,
            squadId: opportunity.squadId,
            linkedKeyResult: opportunity.linkedKeyResult,
          }}
          availableKeyResults={availableKeyResults}
          squads={squads}
          revalidatePathStr={detailPath}
        />

        {/* Tabs */}
        <Tabs defaultValue="solutions">
          <TabsList>
            <TabsTrigger value="solutions">
              Solutions ({opportunity.solutions.length})
            </TabsTrigger>
            <TabsTrigger value="tree">OST Tree</TabsTrigger>
            <TabsTrigger value="evidence">
              Evidence ({evidence.length})
            </TabsTrigger>
            {hasCustomFields && (
              <TabsTrigger value="details">Details</TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="solutions" className="flex flex-col gap-3 pt-4">
            {opportunity.solutions.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No solutions yet. Add one below.
              </p>
            )}
            <SolutionsList
              key={opportunity.solutions.map((s) => s.id).join(",")}
              solutions={opportunity.solutions.map((solution) => ({
                ...solution,
                sortOrder: solution.sortOrder,
                status: solution.status as SolutionStatus,
                assumptions: solution.assumptions.map((a) => ({
                  ...a,
                  sortOrder: a.sortOrder,
                  riskLevel: a.riskLevel as RiskLevel,
                  status: a.status as AssumptionStatus,
                })),
              }))}
              revalidatePathStr={detailPath}
              workspaceId={workspace.id}
              opportunityId={opportunityId}
              squadId={opportunity.squadId}
            />
            <AddSolutionForm
              opportunityId={opportunityId}
              revalidatePathStr={detailPath}
            />
          </TabsContent>

          <TabsContent value="tree" className="pt-4">
            <OSTTreeView
              opportunity={{
                id: opportunity.id,
                title: opportunity.title,
                status: opportunity.status as OpportunityStatus,
                linkedKeyResult: opportunity.linkedKeyResult,
                solutions: opportunity.solutions.map((sol) => ({
                  id: sol.id,
                  title: sol.title,
                  status: sol.status as SolutionStatus,
                  assumptions: sol.assumptions.map((a) => ({
                    id: a.id,
                    title: a.title,
                    riskLevel: a.riskLevel as RiskLevel,
                    status: a.status as AssumptionStatus,
                    experiments: a.experiments.map((exp) => ({
                      id: exp.id,
                      title: exp.title,
                      status: exp.status as ExperimentStatus,
                      conclusion: (exp.conclusion ?? null) as Conclusion | null,
                      hypothesis: exp.hypothesis,
                    })),
                  })),
                })),
              }}
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
            />
          </TabsContent>

          <TabsContent value="evidence" className="flex flex-col gap-3 pt-4">
            <AddEvidenceDialog
              workspaceId={workspace.id}
              nodeType="opportunity"
              nodeId={opportunityId}
              revalidatePathStr={detailPath}
            />
            <EvidenceList
              evidence={evidence.map((e) => ({
                ...e,
                sourceType: e.sourceType as EvidenceSourceType,
                confidence: e.confidence as EvidenceConfidence,
              }))}
              revalidatePathStr={detailPath}
            />
          </TabsContent>

          {hasCustomFields && (
            <TabsContent value="details" className="pt-4">
              <div className="max-w-xl">
                <CustomFieldsPanel
                  fields={customFields}
                  objectId={opportunityId}
                  revalidatePathStr={detailPath}
                />
              </div>
            </TabsContent>
          )}
        </Tabs>
      </div>
    </div>
  );
}
