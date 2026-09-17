import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { agentsEnabled } from "@/lib/agent-access";
import { AccountAgentsPanel } from "@/components/settings/account-agents-panel";
import { AgentActivity } from "@/components/settings/agent-activity";
import { PageHeader } from "@/components/patterns/page-header";
import { SettingsSection } from "@/components/patterns/settings-section";
import { ownerAgentActivityWhere } from "@/lib/agent-activity-visibility";

export const metadata = { title: "My agents" };

export default async function AgentsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const prisma = getPrisma();
  const userId = session.user.id;
  const [agents, workspaces, keys] = await Promise.all([
    prisma.agent.findMany({ where: { ownerUserId: userId }, orderBy: { createdAt: "asc" } }),
    prisma.workspace.findMany({ where: { members: { some: { userId } } }, select: { id: true, name: true, slug: true, organization: { select: { slug: true } } } }),
    prisma.apiKey.findMany({ where: { userId, purpose: "AGENT" }, select: { id: true, agentId: true, name: true, keyPrefix: true, expiresAt: true, revokedAt: true }, orderBy: { createdAt: "desc" } }),
  ]);
  const workspaceIds = workspaces.map((w) => w.id);
  const agentIds = agents.map((a) => a.id);
  const [grants, activity, pendingRequests] = await Promise.all([
    prisma.agentWorkspaceGrant.findMany({ where: { agentId: { in: agentIds }, workspaceId: { in: workspaceIds } } }),
    prisma.agentToolCall.findMany({ where: ownerAgentActivityWhere(userId, agentIds, workspaceIds), orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.agentAccessRequest.findMany({ where: { agentId: { in: agentIds }, workspaceId: { in: workspaceIds }, status: "PENDING" } }),
  ]);
  return <main className="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-8">
    <Link href="/dashboard" className="text-sm text-text-subtle underline">Back to Compass</Link>
    <PageHeader title="My agents" description="Account-wide identities. Use one agent key across workspaces where administrators have enabled access." />
    <AccountAgentsPanel enabled={agentsEnabled()} agents={agents.map((a) => {
      const activeGrantWorkspaceIds = new Set(grants.filter((g) => g.agentId === a.id && !g.revokedAt).map((g) => g.workspaceId));
      const pendingWorkspaceIds = new Set(pendingRequests.filter((r) => r.agentId === a.id).map((r) => r.workspaceId));
      return {
        ...a,
        keys: keys.filter((k) => k.agentId === a.id),
        grants: grants.filter((g) => g.agentId === a.id).map((g) => { const w = workspaces.find((w) => w.id === g.workspaceId)!; return { id: g.id, name: w.name, href: `/${w.organization.slug}/${w.slug}/settings`, access: g.access, revoked: !!g.revokedAt }; }),
        requestable: workspaces.filter((w) => !activeGrantWorkspaceIds.has(w.id) && !pendingWorkspaceIds.has(w.id)).map((w) => ({ id: w.id, name: w.name })),
        pending: pendingRequests.filter((r) => r.agentId === a.id).map((r) => { const w = workspaces.find((w) => w.id === r.workspaceId)!; return { id: r.id, workspaceId: r.workspaceId, name: w.name, access: r.requestedAccess }; }),
      };
    })} />
    <SettingsSection title="Recent agent activity" description="Latest 50 operations in accessible workspaces, including attempts without a recorded workspace. Success means the operation completed, not that the underlying task is finished."><AgentActivity rows={activity.map((r) => ({ ...r, agentName: agents.find((a) => a.id === r.agentId)?.name ?? "Agent", workspaceName: workspaces.find((w) => w.id === r.workspaceId)?.name ?? "Workspace not recorded" }))} /></SettingsSection>
  </main>;
}
