/**
 * Top-level sections that exist at the root of every workspace (see the
 * route tree under app/[orgSlug]/[workspaceSlug]/). Anything past the first
 * path segment (e.g. an opportunityId, docId, experiment id, or OKR cycle
 * id) is scoped to a specific workspace's data and will not exist in a
 * different workspace.
 *
 * Only sections that render a page at their own root belong here (e.g.
 * "reviews" has only a [requestId] route, so it is deliberately absent).
 * __tests__/lib/workspace-nav.test.ts fails if this set drifts from the
 * route tree.
 */
export const TOP_LEVEL_SECTIONS: ReadonlySet<string> = new Set([
  "agent",
  "canvas",
  "capture",
  "decisions",
  "discovery",
  "docs",
  "experiments",
  "feedback",
  "metrics",
  "okrs",
  "roadmap",
  "settings",
  "tasks",
  "updates",
]);

/**
 * Computes the destination path when switching workspaces from the sidebar
 * workspace switcher.
 *
 * Only the top-level section (e.g. "/discovery", "/okrs") is preserved when
 * navigating to the new workspace. Any deeper path segment is a
 * workspace-scoped entity ID from the *current* workspace — carrying it over
 * verbatim causes the new workspace to try to load an entity that doesn't
 * exist there, producing a page error instead of a graceful landing page.
 */
export function getWorkspaceSwitchPath(
  pathname: string,
  fromOrgSlug: string,
  fromWorkspaceSlug: string,
  toOrgSlug: string,
  toWorkspaceSlug: string
): string {
  const base = `/${fromOrgSlug}/${fromWorkspaceSlug}`;
  const currentSection = pathname.startsWith(base) ? pathname.slice(base.length) : "";

  const topLevel = currentSection.split("/")[1]; // "" -> undefined, "/discovery/abc" -> "discovery"
  const safeSection = topLevel && TOP_LEVEL_SECTIONS.has(topLevel) ? `/${topLevel}` : "";

  return `/${toOrgSlug}/${toWorkspaceSlug}${safeSection}`;
}
