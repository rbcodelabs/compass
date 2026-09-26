"use server";

import { auth } from "@/auth";
import { getWorkspace } from "@/lib/workspace";
import * as analytics from "@/lib/analytics/service";
import type { McpActor } from "@/lib/mcp-authz";
import { analyticsAction } from "@/lib/analytics/action-result";

// Metric create/edit/archive are NOT redefined here -- the Metrics page
// reuses createAnalyticsMetric/editAnalyticsMetric/archiveAnalyticsMetric
// from ../settings/analytics-actions.ts directly (see metrics-dashboard.tsx).
// Only the dashboard-layout mutations below are new: nothing before this
// feature persisted widget visibility, size, or order.

async function context(orgSlug: string, workspaceSlug: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id);
  if (!workspace) throw new Error("Workspace not found");
  const actor: McpActor = { userId: session.user.id, purpose: "USER" };
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
