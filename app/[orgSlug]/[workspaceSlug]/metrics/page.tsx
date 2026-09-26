import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getWorkspace } from "@/lib/workspace";
import { listConnections, listDashboardMetrics } from "@/lib/analytics/service";
import { MetricsDashboard } from "@/components/analytics/metrics-dashboard";
import { WorkspacePage } from "@/components/patterns/workspace-page";

export const metadata = { title: "Metrics" };

type Props = {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
};

export default async function MetricsPage({ params }: Props) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { orgSlug, workspaceSlug } = await params;
  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id);
  if (!workspace) redirect("/dashboard");

  const actor = { userId: session.user.id, purpose: "USER" as const };
  const [metrics, connections] = await Promise.all([
    listDashboardMetrics(actor, workspace.id),
    listConnections(actor, workspace.id),
  ]);
  const vercel = connections.find((connection) => connection.provider === "vercel") ?? null;

  return (
    <WorkspacePage
      title="Metrics"
      description="Product usage from your analytics providers, connected to experiments, roadmap launches, and key results."
      contentClassName="md:overflow-y-auto"
    >
      <MetricsDashboard
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        initialMetrics={metrics}
        vercelConnectionId={vercel?.enabled ? vercel.id : null}
      />
    </WorkspacePage>
  );
}
