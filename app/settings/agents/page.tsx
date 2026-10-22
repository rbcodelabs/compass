import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { agentsEnabled } from "@/lib/agent-access";
import { agentKind, listUserOwnedAgents } from "@/lib/agent-ownership";
import { loadConfiguredAgentRunCaps } from "@/lib/agent-limits";
import { allowedAgentModels } from "@/lib/agent-models";
import { AccountAgentsPanel } from "@/components/settings/account-agents-panel";
import { AgentActivity } from "@/components/settings/agent-activity";
import { PageHeader } from "@/components/patterns/page-header";
import { SettingsSection } from "@/components/patterns/settings-section";
import { invokedByForAgentActivity } from "@/lib/agent-activity";
import { ownerAgentActivityWhere } from "@/lib/agent-activity-visibility";
import { ConnectedAppsPanel } from "@/components/settings/connected-apps-panel";
import { getConnectedAppsForUser } from "@/lib/oauth/connected-apps";
import { McpConnectorsPanel } from "@/components/settings/mcp-connectors-panel";
import { trustedCompassBaseUrl } from "@/lib/compass-url";
import { CONNECTOR_DEFINITIONS, connectorAccessView, isConnectorConfigured } from "@/lib/mcp-connectors/config";
// Shared with the callback route that produces these params, so the two cannot
// disagree about their names again (ADR-0018).
import { readConnectorNotice } from "@/lib/mcp-connectors/notice";
import { listConnectedGrants, mcpConnectorsAvailable } from "@/lib/mcp-connectors/store";

export const metadata = { title: "My agents" };

export default async function AgentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const prisma = getPrisma();
  const userId = session.user.id;
  const params = await searchParams;
  const [agents, workspaces, keys, connectedApps, connectorsAvailable] = await Promise.all([
    listUserOwnedAgents(prisma, userId, { orderBy: "createdAt" }),
    prisma.workspace.findMany({ where: { members: { some: { userId } } }, select: { id: true, name: true, slug: true, organization: { select: { slug: true } } } }),
    prisma.apiKey.findMany({ where: { userId, purpose: "AGENT" }, select: { id: true, agentId: true, name: true, keyPrefix: true, expiresAt: true, revokedAt: true }, orderBy: { createdAt: "desc" } }),
    getConnectedAppsForUser(userId),
    mcpConnectorsAvailable(),
  ]);
  // Origin-scoped: a grant registered on production is a different OAuth client
  // from one registered on a preview branch, so a preview must not show it.
  const connectedConnectorScopes = new Map(
    (connectorsAvailable ? await listConnectedGrants(userId, trustedCompassBaseUrl().origin, prisma) : []).map((grant) => [grant.slug, grant.scope]),
  );
  const workspaceIds = workspaces.map((w) => w.id);
  const agentIds = agents.map((a) => a.id);
  const userDefaults = agentIds.length ? await prisma.userDefaultAgent.findMany({ where: { userId, workspaceId: { in: workspaceIds } }, select: { workspaceId: true, agentId: true } }).catch((error: unknown) => { if (typeof error === "object" && error !== null && "code" in error && (error.code === "P2021" || error.code === "P2022")) return []; throw error; }) : [];
  const runCaps = await loadConfiguredAgentRunCaps(prisma, agents.filter((a) => agentKind(a) === "CLOUD").map((a) => a.id));
  const [grants, activity] = await Promise.all([
    prisma.agentWorkspaceGrant.findMany({ where: { agentId: { in: agentIds }, workspaceId: { in: workspaceIds } } }),
    prisma.agentToolCall.findMany({ where: ownerAgentActivityWhere(userId, agentIds, workspaceIds), orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  const invokedBy = await invokedByForAgentActivity(activity);
  return <main className="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-8">
    <Link href="/dashboard" className="text-sm text-text-subtle underline">Back to Compass</Link>
    <PageHeader title="My agents" description="Account-wide identities: cloud agents that run inside Compass, and external agents that connect with a key. Administrators decide which workspaces each can reach." />
    <AccountAgentsPanel enabled={agentsEnabled()} models={allowedAgentModels()} agents={agents.map((a) => ({ kind: agentKind(a), instructions: a.instructions ?? null, model: a.model ?? null, ...(runCaps.get(a.id) ?? {}), workspaces: workspaces.map((w) => ({ orgSlug: w.organization.slug, workspaceSlug: w.slug, name: w.name, enabled: grants.some((g) => g.agentId === a.id && g.workspaceId === w.id && !g.revokedAt), isMyDefault: userDefaults.some((d) => d.agentId === a.id && d.workspaceId === w.id) })), id: a.id, name: a.name, description: a.description ?? null, status: a.status, keys: keys.filter((k) => k.agentId === a.id), grants: grants.filter((g) => g.agentId === a.id).map((g) => { const w = workspaces.find((w) => w.id === g.workspaceId)!; return { id: g.id, name: w.name, href: `/${w.organization.slug}/${w.slug}/settings`, access: g.access, revoked: !!g.revokedAt }; }) }))} />
    <ConnectedAppsPanel connections={connectedApps} />
    <McpConnectorsPanel
      available={connectorsAvailable}
      notice={readConnectorNotice(params)}
      connectors={CONNECTOR_DEFINITIONS.map((definition) => ({
        slug: definition.slug,
        displayName: definition.displayName,
        serverUrl: definition.serverUrl,
        connected: connectedConnectorScopes.has(definition.slug),
        ...connectorAccessView(definition, connectedConnectorScopes.get(definition.slug)),
        configured: isConnectorConfigured(definition),
      }))}
    />
    <SettingsSection title="Recent agent activity" description="Latest 50 operations in accessible workspaces, including attempts without a recorded workspace. Success means the operation completed, not that the underlying task is finished."><AgentActivity rows={activity.map((r) => ({ ...r, invokedByName: invokedBy.get(r) ?? null, agentName: agents.find((a) => a.id === r.agentId)?.name ?? "Agent", workspaceName: workspaces.find((w) => w.id === r.workspaceId)?.name ?? "Workspace not recorded" }))} /></SettingsSection>
  </main>;
}
