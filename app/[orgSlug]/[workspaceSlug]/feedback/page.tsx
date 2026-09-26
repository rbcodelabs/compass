import { Suspense } from "react";
import { redirect, notFound } from "next/navigation";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { FeedbackGrid } from "@/components/feedback/feedback-grid";
import {
  buildFeedbackOrderBy,
  buildFeedbackWhere,
  feedbackQueryString,
  feedbackPageCount,
  feedbackSkip,
  feedbackTake,
  parseFeedbackQuery,
  type FeedbackSearchParams,
} from "@/lib/feedback-query";
import type { FeedbackType } from "@/lib/types";
import { FeedbackHeaderActions } from "@/components/feedback/feedback-header-actions";
import { WorkspacePage } from "@/components/patterns/workspace-page";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata = { title: "Feedback" };

type Props = {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
  searchParams: Promise<FeedbackSearchParams>;
};

export default async function FeedbackPage({ params, searchParams }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { orgSlug, workspaceSlug } = await params;
  const prisma = getPrisma();

  const workspace = await prisma.workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug } },
    select: { id: true, name: true },
  });

  if (!workspace) notFound();

  return (
    <WorkspacePage
      title="Feedback"
      actions={(
        <Suspense>
          <FeedbackHeaderActions />
        </Suspense>
      )}
    >
      {/*
        The grid section is suspended separately from the header so a slow
        `count()` — which has no index story for the `q` search path and can be
        the longest leg of the query — never blocks the page shell from
        painting.
      */}
      <Suspense fallback={<FeedbackGridSkeleton />}>
        <FeedbackGridSection
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          workspaceId={workspace.id}
          searchParams={searchParams}
        />
      </Suspense>
    </WorkspacePage>
  );
}

function FeedbackGridSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

async function FeedbackGridSection({
  orgSlug,
  workspaceSlug,
  workspaceId,
  searchParams,
}: {
  orgSlug: string;
  workspaceSlug: string;
  workspaceId: string;
  searchParams: Promise<FeedbackSearchParams>;
}) {
  const rawSearchParams = await searchParams;
  // Everything is allowlist-validated here; nothing from the request reaches
  // Prisma as a raw string, and hostile input silently falls back to defaults.
  const query = parseFeedbackQuery(rawSearchParams);
  const prisma = getPrisma();

  // ONE `where`, handed to both `findMany` and `count`, so the page contents
  // and the total can never describe different result sets.
  const where = buildFeedbackWhere(query, workspaceId);
  const skip = feedbackSkip(query);
  const take = feedbackTake(query);

  const [feedbackItems, total, unfilteredTotal, opportunities] = await Promise.all([
    prisma.feedbackItem.findMany({
      where,
      // Always ends `{ id: "asc" }`. Without a unique tiebreak, `skip`/`take`
      // over the non-unique status/type/voteCount columns silently duplicates
      // and drops rows between pages.
      orderBy: buildFeedbackOrderBy(query),
      skip,
      take,
      select: {
        id: true,
        title: true,
        description: true,
        submitterName: true,
        submitterEmail: true,
        status: true,
        voteCount: true,
        type: true,
        opportunityId: true,
        createdAt: true,
        roadmapItems: {
          select: { id: true, title: true, horizon: true },
          take: 1,
          orderBy: { createdAt: "desc" },
        },
        attachments: {
          select: { id: true, url: true, filename: true, fileType: true },
        },
      },
    }),
    prisma.feedbackItem.count({ where }),
    // Filter-independent: decides the full "no feedback yet" empty state vs.
    // the compact "nothing matches these filters" one.
    prisma.feedbackItem.count({ where: { workspaceId } }),
    prisma.opportunity.findMany({
      where: { workspaceId, status: { not: "ARCHIVED" } },
      orderBy: { title: "asc" },
      select: { id: true, title: true },
    }),
  ]);

  // A page beyond the end of the result set (bookmarked, or the last item on
  // page 3 just got filtered out) redirects to the last real page rather than
  // rendering an empty table that claims a non-zero total.
  if (skip >= total && total > 0) {
    const lastPage = feedbackPageCount(query, total);
    const qs = feedbackQueryString(query, { page: lastPage });
    redirect(`/${orgSlug}/${workspaceSlug}/feedback${qs ? `?${qs}` : ""}`);
  }

  return (
    <FeedbackGrid
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      workspaceId={workspaceId}
      total={total}
      query={query}
      hasAnyFeedback={unfilteredTotal > 0}
      items={feedbackItems.map((f) => ({
        id: f.id,
        title: f.title,
        description: f.description,
        submitterName: f.submitterName,
        submitterEmail: f.submitterEmail,
        status: f.status,
        voteCount: f.voteCount,
        type: f.type as FeedbackType,
        opportunityId: f.opportunityId,
        roadmapItem: f.roadmapItems[0]
          ? {
              id: f.roadmapItems[0].id,
              title: f.roadmapItems[0].title,
              horizon: f.roadmapItems[0].horizon,
            }
          : null,
        createdAt: f.createdAt.toISOString(),
        attachments: f.attachments,
      }))}
      opportunities={opportunities}
    />
  );
}
