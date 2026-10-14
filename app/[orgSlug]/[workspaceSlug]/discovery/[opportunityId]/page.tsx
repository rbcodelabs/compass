import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeftIcon } from "lucide-react";
import getPrisma from "@/lib/db";
import { getWorkspaceContext, requireWorkspaceContext } from "@/lib/workspace-context";
import { OpportunityDetail } from "@/components/discovery/opportunity-detail";
import { getThinkingModelForSlugs } from "@/lib/thinking-model/server";

type Props = {
  params: Promise<{ orgSlug: string; workspaceSlug: string; opportunityId: string }>;
  searchParams?: Promise<{ tab?: string }>;
};

// Opportunity.id is a UUID column. A path segment that isn't one (a mistyped or
// bookmarked URL such as /discovery/card-sort) would otherwise reach Postgres
// as an invalid uuid literal and surface as a 500 instead of a 404.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: Props) {
  const { orgSlug, workspaceSlug, opportunityId } = await params;
  const { labels } = await getThinkingModelForSlugs(orgSlug, workspaceSlug);
  if (!UUID_PATTERN.test(opportunityId)) return { title: labels.opportunity.singular };
  const context = await getWorkspaceContext(orgSlug, workspaceSlug);
  if (context.status !== "ok") return { title: labels.opportunity.singular };
  const opportunity = await getPrisma().opportunity.findFirst({
    where: { id: opportunityId, workspaceId: context.workspace.id }, select: { title: true },
  });
  return { title: opportunity?.title ?? labels.opportunity.singular };
}

export default async function OpportunityDetailPage({ params, searchParams }: Props) {
  const { orgSlug, workspaceSlug, opportunityId } = await params;
  if (!UUID_PATTERN.test(opportunityId)) notFound();
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
