import getPrisma from "@/lib/db";
import { getPortalSession } from "@/lib/portal-auth";
import { FeedbackPortalSection } from "@/components/portal/feedback-portal-section";
import { PUBLIC_FEEDBACK_SELECT, publicFeedbackItemWhere, serializePublicFeedbackItem } from "@/lib/public-feedback";
import type { FeedbackType } from "@/lib/types";
import { EmptyState } from "@/components/patterns/empty-state";

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
      <EmptyState
        title="Feedback is not enabled"
        description="The workspace owner has not enabled the public feedback portal."
      />
    );
  }

  const items = await prisma.feedbackItem.findMany({
    where: publicFeedbackItemWhere(workspace.id),
    orderBy: [{ voteCount: "desc" }, { createdAt: "desc" }],
    select: PUBLIC_FEEDBACK_SELECT,
  });

  return (
    <FeedbackPortalSection
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      portalAuthRequired={workspace.portalAuthRequired ?? false}
      portalAccountEmail={portalSession?.email ?? null}
      initialItems={items.map((i) => ({ ...serializePublicFeedbackItem(i), type: i.type as FeedbackType }))}
    />
  );
}
