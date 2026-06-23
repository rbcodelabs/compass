import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ChevronLeftIcon } from "lucide-react";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SolutionCard } from "@/components/discovery/solution-card";
import { AddSolutionForm } from "@/components/discovery/add-solution-form";
import { OpportunityOverview } from "@/components/discovery/opportunity-overview";
import type { OpportunityStatus, SolutionStatus, AssumptionStatus, RiskLevel } from "@/lib/types";

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

  const opportunity = await prisma.opportunity.findFirst({
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
              experiments: { select: { id: true } },
            },
          },
        },
      },
    },
  });

  if (!opportunity) notFound();

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
            />
          ))}
          <AddSolutionForm
            opportunityId={opportunityId}
            revalidatePathStr={detailPath}
          />
        </TabsContent>

        <TabsContent value="overview" className="pt-4">
          <OpportunityOverview
            opportunity={{ ...opportunity, status: opportunity.status as OpportunityStatus }}
            revalidatePathStr={detailPath}
          />
        </TabsContent>
      </Tabs>
    </main>
  );
}
