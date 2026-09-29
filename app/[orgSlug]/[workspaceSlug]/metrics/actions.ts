"use server";

import { auth } from "@/auth";
import { getWorkspace } from "@/lib/workspace";
import * as analytics from "@/lib/analytics/service";
import type { McpActor } from "@/lib/mcp-authz";
import { analyticsAction } from "@/lib/analytics/action-result";
import { assertWorkspaceWritable } from "@/lib/workspace-context";

// Metric create/edit/archive are NOT redefined here -- the Metrics page
// reuses createAnalyticsMetric/editAnalyticsMetric/archiveAnalyticsMetric
// from ../settings/analytics-actions.ts directly (see metrics-dashboard.tsx).
// Only the dashboard-layout mutations below are new: nothing before this
// feature persisted widget visibility, size, or order.

// Every exported function in this file mutates dashboard layout, so the
// read-only guard lives directly in the shared resolver rather than at each
// call site -- unlike ../settings/analytics-actions.ts, which also exports a
// read (listAnalyticsConnections) that must NOT be gated here.
async function context(orgSlug: string, workspaceSlug: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id);
  if (!workspace) throw new Error("Workspace not found");
  assertWorkspaceWritable(workspace);
  const actor: McpActor = { userId: session.user.id, purpose: "USER", scopeWorkspaceId: workspace.id };
  return { actor, workspaceId: workspace.id };
}

export async function resizeDashboardMetric(orgSlug: string, workspaceSlug: string, metricId: string, layout: { col: number; row: number }) {
  const { actor, workspaceId } = await context(orgSlug, workspaceSlug);
  return analyticsAction(() => analytics.updateMetricDashboardLayout(actor, workspaceId, metricId, layout));
}

export async function setDashboardMetricVisible(orgSlug: string, workspaceSlug: string, metricId: string, visible: boolean) {
  const { actor, workspaceId } = await context(orgSlug, workspaceSlug);
  return analyticsAction(() => analytics.setMetricDashboardVisible(actor, workspaceId, metricId, visible));
}

export async function reorderDashboardMetric(orgSlug: string, workspaceSlug: string, metricId: string, sortOrder: number) {
  const { actor, workspaceId } = await context(orgSlug, workspaceSlug);
  return analyticsAction(() => analytics.reorderDashboardMetric(actor, workspaceId, metricId, sortOrder));
}
