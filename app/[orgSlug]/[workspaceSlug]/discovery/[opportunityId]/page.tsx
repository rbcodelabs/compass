import { resolveWorkItemPage, type PageSearchParams } from "@/lib/work-item-page";
import { resolveWorkItemId } from "@/lib/work-item-resolve";
import Link from "next/link";
import { ChevronLeftIcon } from "lucide-react";
import getPrisma from "@/lib/db";
import { getWorkspaceContext, requireWorkspaceContext } from "@/lib/workspace-context";
import { OpportunityDetail } from "@/components/discovery/opportunity-detail";
import { getThinkingModelForSlugs } from "@/lib/thinking-model/server";

type Props = {
  params: Promise<{ orgSlug: string; workspaceSlug: string; opportunityId: string }>;
  searchParams?: Promise<{ tab?: string } & NonNullable<PageSearchParams>>;
};

// The segment is a UUID or a display ID (OPP-12). The resolver classifies it first, so a mistyped or
// bookmarked URL such as /discovery/card-sort is a 404, never an invalid uuid literal reaching Postgres.

export async function generateMetadata({ params }: Props) {
  const { orgSlug, workspaceSlug, opportunityId } = await params;
  const { labels } = await getThinkingModelForSlugs(orgSlug, workspaceSlug);
  const context = await getWorkspaceContext(orgSlug, workspaceSlug);
  if (context.status !== "ok") return { title: labels.opportunity.singular };
  const resolvedId = await resolveWorkItemId(getPrisma(), context.workspace.id, "opportunity", opportunityId);
  const opportunity = resolvedId ? await getPrisma().opportunity.findFirst({
    where: { id: resolvedId, workspaceId: context.workspace.id }, select: { title: true },
  }) : null;
  return { title: opportunity?.title ?? labels.opportunity.singular };
}

export default async function OpportunityDetailPage({ params, searchParams }: Props) {
  const { orgSlug, workspaceSlug, opportunityId } = await params;
  const { workspace } = await requireWorkspaceContext(orgSlug, workspaceSlug);
  const query = (await searchParams) ?? {};
  const opportunity = await resolveWorkItemPage({ type: "opportunity", param: opportunityId, workspaceId: workspace.id, basePath: `/${orgSlug}/${workspaceSlug}/discovery`, searchParams: query });
  const { tab } = query;
  return (
    <div className="min-h-full min-w-0 p-4 sm:p-6 md:p-8">
      <div className="mx-auto flex max-w-7xl min-w-0 flex-col gap-6">
        <Link href={`/${orgSlug}/${workspaceSlug}/discovery`} className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeftIcon className="size-4" /> Discovery
        </Link>
        <OpportunityDetail opportunityId={opportunity.id} orgSlug={orgSlug} workspaceSlug={workspaceSlug} variant="page" initialTab={tab} />
      </div>
    </div>
  );
}
