import type { PortalHomeWidget } from "./schema"

export interface DefaultHomeContext {
  workspaceName: string
  orgSlug: string
  workspaceSlug: string
  roadmapPublic: boolean
  feedbackEnabled: boolean
}

/**
 * The home a workspace gets before any admin has published a layout. Built from
 * the workspace's own portal flags so it never advertises a surface that is
 * switched off (and the resolvers hide those widgets regardless).
 */
export function buildDefaultWidgets(ctx: DefaultHomeContext): PortalHomeWidget[] {
  const base = `/portal/${ctx.orgSlug}/${ctx.workspaceSlug}`
  const primaryCta = ctx.roadmapPublic
    ? { label: "See the roadmap", url: `${base}/roadmap` }
    : ctx.feedbackEnabled
      ? { label: "Share feedback", url: `${base}/feedback` }
      : null
  return [
    {
      id: "default-announcement",
      type: "announcement",
      size: "L",
      order: 0,
      visibility: "everyone",
      config: {
        eyebrow: "Welcome",
        headline: `Welcome to ${ctx.workspaceName}`.slice(0, 140),
        body: "Follow what we are building, see what has shipped, and tell us what you need.",
        primaryCta,
        secondaryCta: null,
      },
    },
    {
      id: "default-roadmap",
      type: "roadmap_spotlight",
      size: "M",
      order: 1,
      visibility: "everyone",
      config: { title: "On the roadmap", itemIds: [], show: "status" },
    },
    {
      id: "default-updates",
      type: "recent_updates",
      size: "M",
      order: 2,
      visibility: "everyone",
      config: { title: "Recently shipped", limit: 4 },
    },
    {
      id: "default-feedback",
      type: "feedback_cta",
      size: "L",
      order: 3,
      visibility: "everyone",
      config: {
        title: "Got an idea?",
        description: "Tell us what would make your day easier.",
        buttonLabel: "Submit feedback",
        showTopIdeas: true,
      },
    },
  ]
}
