import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeftIcon } from "lucide-react";
import getPrisma from "@/lib/db";
import { getWorkspaceContext, requireWorkspaceContext } from "@/lib/workspace-context";
import { OpportunityDetail } from "@/components/discovery/opportunity-detail";

type Props = {
  params: Promise<{ orgSlug: string; workspaceSlug: string; opportunityId: string }>;
  searchParams?: Promise<{ tab?: string }>;
};

export async function generateMetadata({ params }: Props) {
  const { orgSlug, workspaceSlug, opportunityId } = await params;
  const context = await getWorkspaceContext(orgSlug, workspaceSlug);
  if (context.status !== "ok") return { title: "Opportunity" };
  const opportunity = await getPrisma().opportunity.findFirst({
    where: { id: opportunityId, workspaceId: context.workspace.id }, select: { title: true },
  });
  return { title: opportunity?.title ?? "Opportunity" };
}

export default async function OpportunityDetailPage({ params, searchParams }: Props) {
  const { orgSlug, workspaceSlug, opportunityId } = await params;
  const { workspace } = await requireWorkspaceContext(orgSlug, workspaceSlug);
  const opportunity = await getPrisma().opportunity.findFirst({ where: { id: opportunityId, workspaceId: workspace.id }, select: { id: true } });
  if (!opportunity) notFound();
  const { tab } = (await searchParams) ?? {};
  return (
    <div className="min-h-full min-w-0 p-4 sm:p-6 md:p-8">
      <div className="mx-auto flex max-w-7xl min-w-0 flex-col gap-6">
        <Link href={`/${orgSlug}/${workspaceSlug}/discovery`} className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeftIcon className="size-4" /> Discovery
        </Link>
        <OpportunityDetail opportunityId={opportunityId} orgSlug={orgSlug} workspaceSlug={workspaceSlug} variant="page" initialTab={tab} />
      </div>
    </div>
  );
}
