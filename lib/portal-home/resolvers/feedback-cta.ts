import type { FeedbackCtaConfig } from "../widgets/feedback-cta"
import type { WidgetResolution } from "../data"
import { portalBase, type ResolveContext } from "./context"

const TOP_IDEAS = 3

export async function resolveFeedbackCta(ctx: ResolveContext, config: FeedbackCtaConfig): Promise<WidgetResolution> {
  if (!ctx.workspace.feedbackEnabled) return { available: false, reason: "The feedback portal is not enabled." }

  // Same visibility rule as the public feedback page: everything except declined items.
  const rows = config.showTopIdeas
    ? await ctx.prisma.feedbackItem.findMany({
        where: { workspaceId: ctx.workspace.id, status: { not: "DECLINED" } },
        orderBy: [{ voteCount: "desc" }, { createdAt: "desc" }],
        take: TOP_IDEAS,
        select: { id: true, title: true, voteCount: true },
      })
    : []
  return {
    available: true,
    data: {
      type: "feedback_cta",
      feedbackHref: `${portalBase(ctx)}/feedback`,
      topIdeas: rows.filter((row) => row.voteCount > 0).map((row) => ({ id: row.id, title: row.title, voteCount: row.voteCount })),
    },
  }
}
