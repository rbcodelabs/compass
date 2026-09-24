"use server";

import { auth } from "@/auth";
import { getWorkspace } from "@/lib/workspace";
import * as analytics from "@/lib/analytics/service";
import type { McpActor } from "@/lib/mcp-authz";
import { analyticsAction } from "@/lib/analytics/action-result";

export async function disconnectAnalytics(orgSlug: string, workspaceSlug: string, connectionId: string) {
  const { actor, workspaceId } = await context(orgSlug, workspaceSlug);
  return analyticsAction(() => analytics.disconnectConnection(actor, workspaceId, connectionId));
}

export async function editAnalyticsMetric(orgSlug: string, workspaceSlug: string, metricId: string, input: analytics.MetricInput & { expectedRevision: number }) {
  const { actor, workspaceId } = await context(orgSlug, workspaceSlug);
  return analyticsAction(() => analytics.updateMetric(actor, workspaceId, metricId, input));
}

export async function archiveAnalyticsMetric(orgSlug: string, workspaceSlug: string, metricId: string) {
  const { actor, workspaceId } = await context(orgSlug, workspaceSlug);
  return analyticsAction(() => analytics.archiveMetric(actor, workspaceId, metricId));
}

export async function linkAnalyticsMetric(orgSlug: string, workspaceSlug: string, input: analytics.LinkMetricInput) {
  const { actor, workspaceId } = await context(orgSlug, workspaceSlug);
  return analyticsAction(() => analytics.linkMetric(actor, workspaceId, input));
}

export async function updateAnalyticsMeasurement(orgSlug: string, workspaceSlug: string, bindingId: string, input: analytics.UpdateMetricBindingInput) {
  const { actor, workspaceId } = await context(orgSlug, workspaceSlug);
  return analyticsAction(() => analytics.updateBinding(actor, workspaceId, bindingId, input));
}

export async function unlinkAnalyticsMetric(orgSlug: string, workspaceSlug: string, bindingId: string) {
  const { actor, workspaceId } = await context(orgSlug, workspaceSlug);
  return analyticsAction(() => analytics.unlinkMetric(actor, workspaceId, bindingId));
}

export async function refreshAnalyticsMeasurement(orgSlug: string, workspaceSlug: string, bindingId: string, requestId: string) {
  const { actor, workspaceId } = await context(orgSlug, workspaceSlug);
  return analyticsAction(() => analytics.refreshBinding(actor, workspaceId, bindingId, requestId));
}

export async function listAnalyticsMetrics(orgSlug: string, workspaceSlug: string) {
  const { actor, workspaceId } = await context(orgSlug, workspaceSlug);
  return analytics.listMetrics(actor, workspaceId);
}

export async function listAnalyticsConnections(orgSlug: string, workspaceSlug: string) {
  const { actor, workspaceId } = await context(orgSlug, workspaceSlug);
  return analytics.listConnections(actor, workspaceId);
}

async function context(orgSlug: string, workspaceSlug: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id);
  if (!workspace) throw new Error("Workspace not found");
  const actor: McpActor = { userId: session.user.id, purpose: "USER" };
  return { actor, workspaceId: workspace.id };
}

export async function createAnalyticsMetric(orgSlug: string, workspaceSlug: string, input: analytics.MetricInput) {
  const { actor, workspaceId } = await context(orgSlug, workspaceSlug);
  return analyticsAction(() => analytics.createMetric(actor, workspaceId, input));
}

export async function connectAnalytics(orgSlug: string, workspaceSlug: string, input: { projectId: string; teamId?: string; token: string }) {
  const { actor, workspaceId } = await context(orgSlug, workspaceSlug);
  // The shared service independently requires a human workspace/org admin.
  return analyticsAction(() => analytics.saveVercelConnection(actor, workspaceId, input));
}

export async function readMeasurements(orgSlug: string, workspaceSlug: string, target: analytics.MetricTarget) {
  const { actor, workspaceId } = await context(orgSlug, workspaceSlug);
  const bindings = await analytics.listBindings(actor, workspaceId, target);
  return Promise.all(bindings.map(async binding => ({ binding, observations: await analytics.listObservations(actor, workspaceId, binding.id) })));
}
