import { redirect, notFound } from "next/navigation";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { InternalFeedbackBoard } from "@/components/feedback/internal-feedback-board";
import type { FeedbackType } from "@/lib/types";

export const metadata = { title: "Feedback" };

type Props = {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
};

export default async function FeedbackPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { orgSlug, workspaceSlug } = await params;
  const prisma = getPrisma();

  const workspace = await prisma.workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug } },
    select: { id: true, name: true },
  });

  if (!workspace) notFound();

  const [feedbackItems, opportunities] = await Promise.all([
    prisma.feedbackItem.findMany({
      where: { workspaceId: workspace.id },
      orderBy: [{ voteCount: "desc" }, { createdAt: "desc" }],
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
    prisma.opportunity.findMany({
      where: { workspaceId: workspace.id, status: { not: "ARCHIVED" } },
      orderBy: { title: "asc" },
      select: { id: true, title: true },
    }),
  ]);

  return (
    <main className="flex flex-col flex-1 p-4 sm:p-6 md:p-8 gap-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900">Feedback</h1>
        <p className="text-sm text-slate-500 mt-1">
          Customer submissions for {workspace.name}
        </p>
      </div>

      <InternalFeedbackBoard
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        workspaceId={workspace.id}
        initialItems={feedbackItems.map((f) => ({
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
            ? { id: f.roadmapItems[0].id, title: f.roadmapItems[0].title, horizon: f.roadmapItems[0].horizon }
            : null,
          createdAt: f.createdAt.toISOString(),
          attachments: f.attachments,
        }))}
        opportunities={opportunities}
      />
    </main>
  );
}
