import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ChevronLeftIcon } from "lucide-react";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SolutionsList } from "@/components/discovery/solutions-list";
import { AddSolutionForm } from "@/components/discovery/add-solution-form";
import { OpportunityHeader } from "@/components/discovery/opportunity-header";
import { LinkedFeedback } from "@/components/discovery/linked-feedback";
import { OSTTreeView } from "@/components/discovery/ost-tree-view";
import { CustomFieldsPanel } from "@/components/custom-fields/custom-fields-panel";
import { toCustomFieldDefinitionData } from "@/lib/custom-field-definitions";
import { ScoringPanel } from "@/components/discovery/scoring-panel";
import { EvidenceList } from "@/components/discovery/evidence-list";
import { AddEvidenceDialog } from "@/components/discovery/add-evidence-dialog";
import { FleshThisOutLink } from "@/components/research/flesh-this-out-link";
import { PmInterviewHistory } from "@/components/research/pm-interview-history";
import { isPmInterviewEnabled } from "@/lib/research-feature";
import { resolveWorkspaceScoringModel, toOpportunityScoreData } from "@/lib/scoring-model";
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
  OpportunityScoreData,
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
  /** `?tab=scoring` deep-links the Scoring tab — the Discovery board's
   *  "Not scored" affordance links straight here. */
  searchParams?: Promise<{ tab?: string }>;
};

export default async function OpportunityDetailPage({ params, searchParams }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { orgSlug, workspaceSlug, opportunityId } = await params;
  const { tab: requestedTab } = (await searchParams) ?? {};
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
        feedback: {
          where: { workspaceId: workspace.id },
          select: { id: true, title: true, type: true, status: true },
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        },
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
            comments: {
              orderBy: { createdAt: "asc" },
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

  const pmInterviews = isPmInterviewEnabled() ? await prisma.pMInterview.findMany({
    where: { workspaceId: workspace.id, targetType: "OPPORTUNITY", targetId: opportunityId },
    orderBy: { createdAt: "desc" }, take: 20,
    select: { id: true, disposition: true, generationState: true, agentConversationId: true, createdAt: true },
  }) : [];

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
    include: { sharedOptionSet: { select: { id: true, name: true, options: true } } },
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
      ...toCustomFieldDefinitionData(f),
      objectType: "OPPORTUNITY" as const,
      currentValue: (valueByFieldId.get(f.id) ?? null) as CustomFieldValue,
    }));

  // Fetch the workspace's active scoring model (if any) and this
  // opportunity's existing score. The Scoring tab only renders when the
  // workspace has an active model, mirroring the hasCustomFields pattern.
  const scoringModel = await resolveWorkspaceScoringModel(workspace.id);

  const rawScore = scoringModel
    ? await prisma.opportunityScore.findUnique({ where: { opportunityId } })
    : null;

  const existingScore: OpportunityScoreData | null = toOpportunityScoreData(
    rawScore,
    scoringModel
  );

  const boardPath = `/${orgSlug}/${workspaceSlug}/discovery`;
  const detailPath = `/${orgSlug}/${workspaceSlug}/discovery/${opportunityId}`;

  const hasCustomFields = customFields.length > 0;
  const hasActiveScoringModel = scoringModel !== null;

  // Only honour tabs that actually render — `?tab=scoring` on a workspace with
  // no active model would otherwise select a tab that does not exist.
  const availableTabs = new Set(
    ["solutions", "tree", "evidence"]
      .concat(hasActiveScoringModel ? ["scoring"] : [])
      .concat(hasCustomFields ? ["details"] : [])
  );
  const initialTab =
    requestedTab && availableTabs.has(requestedTab) ? requestedTab : "solutions";

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
        {isPmInterviewEnabled() && <FleshThisOutLink orgSlug={orgSlug} workspaceSlug={workspaceSlug} targetType="OPPORTUNITY" targetId={opportunityId} />}

        <LinkedFeedback feedback={opportunity.feedback} />

        {/* Tabs */}
        <Tabs defaultValue={initialTab}>
          <TabsList>
            <TabsTrigger value="solutions">
              Solutions ({opportunity.solutions.length})
            </TabsTrigger>
            <TabsTrigger value="tree">OST Tree</TabsTrigger>
            {hasActiveScoringModel && (
              <TabsTrigger value="scoring">Scoring</TabsTrigger>
            )}
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
                id: solution.id,
                title: solution.title,
                description: solution.description,
                sortOrder: solution.sortOrder,
                status: solution.status as SolutionStatus,
                _count: {
                  assumptions: solution.assumptions.length,
                  evidence: solution._count.evidence,
                },
              }))}
              revalidatePathStr={detailPath}
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

          {hasActiveScoringModel && scoringModel && (
            <TabsContent value="scoring" className="pt-4">
              <ScoringPanel
                orgSlug={orgSlug}
                workspaceSlug={workspaceSlug}
                opportunityId={opportunityId}
                revalidatePathStr={detailPath}
                scoringModel={scoringModel}
                existingScore={existingScore}
              />
            </TabsContent>
          )}

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
        <PmInterviewHistory orgSlug={orgSlug} workspaceSlug={workspaceSlug} interviews={pmInterviews} />
      </div>
    </div>
  );
}
