import type { FeedbackCtaConfig } from "../widgets/feedback-cta"
import type { WidgetResolution } from "../data"
import { publicFeedbackItemWhere } from "@/lib/public-feedback"
import { surfaceBase, type ResolveContext } from "./context"

const TOP_IDEAS = 3

export async function resolveFeedbackCta(ctx: ResolveContext, config: FeedbackCtaConfig): Promise<WidgetResolution> {
  // Customers: only when the public feedback portal is on. The team sees
  // everything internal regardless of that switch.
  if (ctx.audience === "customer" && !ctx.workspace.feedbackEnabled) {
    return { available: false, reason: "The feedback portal is not enabled." }
  }

  // Customers get the shared public predicate (portal-sourced, not declined); the
  // team sees every non-declined item.
  const rows = config.showTopIdeas
    ? await ctx.prisma.feedbackItem.findMany({
        where: ctx.audience === "customer" ? publicFeedbackItemWhere(ctx.workspace.id) : { workspaceId: ctx.workspace.id, status: { not: "DECLINED" } },
        orderBy: [{ voteCount: "desc" }, { createdAt: "desc" }],
        take: TOP_IDEAS,
        select: { id: true, title: true, voteCount: true },
      })
    : []
  return {
    available: true,
    data: {
      type: "feedback_cta",
      feedbackHref: `${surfaceBase(ctx)}/feedback`,
      topIdeas: rows.filter((row) => row.voteCount > 0).map((row) => ({ id: row.id, title: row.title, voteCount: row.voteCount })),
    },
  }
}
