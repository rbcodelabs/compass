import { sortWidgets, type PortalHomeWidget } from "./schema"
import { isWidgetVisibleToCustomer, isWidgetVisibleToTeam, type HomeViewer } from "./visibility"
import type { WidgetResolution } from "./data"
import type { CustomerResolveContext, ResolveContext, ResolveInput, TeamResolveContext } from "./resolvers/context"
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
  ctx: ResolveInput,
  widgets: readonly PortalHomeWidget[],
  viewer: HomeViewer,
): Promise<ResolvedHome> {
  const customerCtx: CustomerResolveContext = { ...ctx, audience: "customer" }
  const visible = sortWidgets(widgets).filter((widget) => isWidgetVisibleToCustomer(widget, viewer))
  const resolutions = await Promise.all(visible.map((widget) => resolveWidget(customerCtx, widget)))
  const shown: PortalHomeWidget[] = []
  const resolved: Record<string, WidgetResolution> = {}
  visible.forEach((widget, index) => {
    const resolution = resolutions[index]
    if (!resolution.available) return
    shown.push(redactForCustomer(widget, resolution))
    resolved[widget.id] = resolution
  })
  return { widgets: shown, resolved }
}

/**
 * The widget config is serialized to the browser alongside its resolution. A
 * spotlight's pinned ids may name private items (admins can pin them for the
 * team view), so only ids that actually resolved publicly are kept.
 */
function redactForCustomer(widget: PortalHomeWidget, resolution: WidgetResolution): PortalHomeWidget {
  if (widget.type !== "roadmap_spotlight") return widget
  const publicIds = new Set(resolution.available && resolution.data.type === "roadmap_spotlight" ? resolution.data.items.map((item) => item.id) : [])
  return { ...widget, config: { ...widget.config, itemIds: widget.config.itemIds.filter((id) => publicIds.has(id)) } }
}

/**
 * Team audience (the Compass team home, /[org]/[ws]/home). Callers MUST have
 * authorized the viewer as a workspace member first: this runs as
 * the "team" audience: INTERNAL data (private roadmap items, feedback with no
 * public gate, Doc links, in-app links) regardless of the Public roadmap /
 * Feedback switches. Shows every widget the team may see (everyone, signed_in,
 * team); segments stays hidden. Widgets with nothing to show are dropped. Kept separate
 * from resolveHomeForCustomer so the customer path never has a "team" branch to
 * get wrong.
 */
export async function resolveHomeForTeam(
  ctx: ResolveInput,
  widgets: readonly PortalHomeWidget[],
): Promise<ResolvedHome> {
  const teamCtx: TeamResolveContext = { ...ctx, audience: "team" }
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
 * Member (admin editor) audience: the team's internal data for every widget, with
 * its resolution or the reason it is empty. It says NOTHING about customer
 * availability; use resolveCustomerAvailability for that. Only ever served by routes behind
 * resolveWorkspaceAdmin; never reachable from the portal itself.
 */
export async function resolveHomeForMember(
  ctx: ResolveInput,
  widgets: readonly PortalHomeWidget[],
): Promise<Record<string, WidgetResolution>> {
  const memberCtx: TeamResolveContext = { ...ctx, audience: "team" }
  const sorted = sortWidgets(widgets)
  const resolutions = await Promise.all(sorted.map((widget) => resolveWidget(memberCtx, widget)))
  return Object.fromEntries(sorted.map((widget, index) => [widget.id, resolutions[index]]))
}

export type CustomerAvailability = { shown: true } | { shown: false; reason: string }

const VISIBILITY_REASON: Partial<Record<PortalHomeWidget["visibility"], string>> = {
  team: "This widget is set to Team only.",
  segments: "Specific segments are not available yet.",
}

/**
 * Editor annotation: will each draft widget reach customers? Runs the REAL
 * customer rules (visibility filter, then the customer resolver with the public
 * predicates), evaluated for a signed-in customer so "Signed-in customers"
 * widgets report on their data rather than on the viewer. Never returns data,
 * only a verdict and a reason, so it is safe to show next to team-resolved data.
 */
export async function resolveCustomerAvailability(
  ctx: ResolveInput,
  widgets: readonly PortalHomeWidget[],
): Promise<Record<string, CustomerAvailability>> {
  const customerCtx: CustomerResolveContext = { ...ctx, audience: "customer" }
  const entries = await Promise.all(
    sortWidgets(widgets).map(async (widget): Promise<[string, CustomerAvailability]> => {
      if (!isWidgetVisibleToCustomer(widget, { signedIn: true })) {
        return [widget.id, { shown: false, reason: VISIBILITY_REASON[widget.visibility] ?? "Not visible to customers." }]
      }
      const resolution = await resolveWidget(customerCtx, widget)
      return [widget.id, resolution.available ? { shown: true } : { shown: false, reason: resolution.reason }]
    }),
  )
  return Object.fromEntries(entries)
}

