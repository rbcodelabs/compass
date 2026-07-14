import getPrisma from "@/lib/db";
import { getPortalSession } from "@/lib/portal-auth";
import { FeedbackPortalSection } from "@/components/portal/feedback-portal-section";
import type { FeedbackType } from "@/lib/types";

type Props = {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
};

export default async function PortalFeedbackPage({ params }: Props) {
  const { orgSlug, workspaceSlug } = await params;
  const prisma = getPrisma();

  const [workspace, portalSession] = await Promise.all([
    prisma.workspace.findFirst({
      where: { slug: workspaceSlug, organization: { slug: orgSlug } },
      select: { id: true, name: true, feedbackEnabled: true, portalAuthRequired: true },
    }),
    getPortalSession(),
  ]);

  if (!workspace || !workspace.feedbackEnabled) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <p className="text-lg font-semibold text-slate-700">Feedback is not enabled</p>
        <p className="text-sm text-slate-500 mt-1">
          The workspace owner has not enabled the public feedback portal.
        </p>
      </div>
    );
  }

  const items = await prisma.feedbackItem.findMany({
    where: {
      workspaceId: workspace.id,
      status: { not: "DECLINED" },
    },
    orderBy: [{ voteCount: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      title: true,
      description: true,
      status: true,
      voteCount: true,
      type: true,
      submitterName: true,
      createdAt: true,
    },
  });

  return (
    <FeedbackPortalSection
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      portalAuthRequired={workspace.portalAuthRequired ?? false}
      portalAccountEmail={portalSession?.email ?? null}
      initialItems={items.map((i) => ({
        id: i.id,
        title: i.title,
        description: i.description,
        status: i.status,
        voteCount: i.voteCount,
        type: i.type as FeedbackType,
        submitterName: i.submitterName,
        createdAt: i.createdAt.toISOString(),
      }))}
    />
  );
}
