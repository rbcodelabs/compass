import { sortWidgets, type PortalHomeWidget } from "./schema"
import { isWidgetVisibleToCustomer, isWidgetVisibleToTeam, type HomeViewer } from "./visibility"
import type { WidgetResolution } from "./data"
import type { ResolveContext } from "./resolvers/context"
import { resolveKeyLinks } from "./resolvers/key-links"
import { resolveRoadmapSpotlight } from "./resolvers/roadmap-spotlight"
import { resolveRecentUpdates } from "./resolvers/recent-updates"
import { resolveFeedbackCta } from "./resolvers/feedback-cta"

async function resolveWidget(ctx: ResolveContext, widget: PortalHomeWidget): Promise<WidgetResolution> {
  switch (widget.type) {
    case "announcement":
      return { available: true, data: { type: "announcement" } }
    case "rich_text":
      return widget.config.body || widget.config.title
        ? { available: true, data: { type: "rich_text" } }
        : { available: false, reason: "This text block is empty." }
    case "key_links":
      return resolveKeyLinks(ctx, widget.config)
    case "roadmap_spotlight":
      return resolveRoadmapSpotlight(ctx, widget.config)
    case "recent_updates":
      return resolveRecentUpdates(ctx, widget.config)
    case "feedback_cta":
      return resolveFeedbackCta(ctx, widget.config)
  }
}

export interface ResolvedHome {
  widgets: PortalHomeWidget[]
  resolved: Record<string, WidgetResolution>
}

/**
 * Customer audience. THE enforcement point for the leakage boundary:
 *  1. widgets the viewer may not see are removed BEFORE any resolver runs, so no
 *     query is made and no data exists for them;
 *  2. each resolver applies the public portal's own visibility rules;
 *  3. widgets whose surface is off or empty are dropped.
 * What comes back is safe to serialize to the browser as-is.
 */
export async function resolveHomeForCustomer(
  ctx: Omit<ResolveContext, "isWorkspaceMember">,
  widgets: readonly PortalHomeWidget[],
  viewer: HomeViewer,
): Promise<ResolvedHome> {
  const customerCtx: ResolveContext = { ...ctx, isWorkspaceMember: false }
  const visible = sortWidgets(widgets).filter((widget) => isWidgetVisibleToCustomer(widget, viewer))
  const resolutions = await Promise.all(visible.map((widget) => resolveWidget(customerCtx, widget)))
  const shown: PortalHomeWidget[] = []
  const resolved: Record<string, WidgetResolution> = {}
  visible.forEach((widget, index) => {
    if (!resolutions[index].available) return
    shown.push(widget)
    resolved[widget.id] = resolutions[index]
  })
  return { widgets: shown, resolved }
}

/**
 * Team audience (the Compass team home, /[org]/[ws]/home). Callers MUST have
 * authorized the viewer as a workspace member first: this runs with
 * isWorkspaceMember: true, which unlocks Doc links. Shows every widget the team
 * may see (everyone, signed_in, team); segments stays hidden. Widgets whose
 * surface is off or empty are dropped, as on the customer page. Kept separate
 * from resolveHomeForCustomer so the customer path never has a "team" branch to
 * get wrong.
 */
export async function resolveHomeForTeam(
  ctx: Omit<ResolveContext, "isWorkspaceMember">,
  widgets: readonly PortalHomeWidget[],
): Promise<ResolvedHome> {
  const teamCtx: ResolveContext = { ...ctx, isWorkspaceMember: true }
  const visible = sortWidgets(widgets).filter(isWidgetVisibleToTeam)
  const resolutions = await Promise.all(visible.map((widget) => resolveWidget(teamCtx, widget)))
  const shown: PortalHomeWidget[] = []
  const resolved: Record<string, WidgetResolution> = {}
  visible.forEach((widget, index) => {
    if (!resolutions[index].available) return
    shown.push(widget)
    resolved[widget.id] = resolutions[index]
  })
  return { widgets: shown, resolved }
}

/**
 * Member (admin editor) audience: every widget, with its resolution or the
 * reason it is unavailable. Only ever served by routes behind
 * resolveWorkspaceAdmin; never reachable from the portal itself.
 */
export async function resolveHomeForMember(
  ctx: Omit<ResolveContext, "isWorkspaceMember">,
  widgets: readonly PortalHomeWidget[],
): Promise<Record<string, WidgetResolution>> {
  const memberCtx: ResolveContext = { ...ctx, isWorkspaceMember: true }
  const sorted = sortWidgets(widgets)
  const resolutions = await Promise.all(sorted.map((widget) => resolveWidget(memberCtx, widget)))
  return Object.fromEntries(sorted.map((widget, index) => [widget.id, resolutions[index]]))
}

