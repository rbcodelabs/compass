import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { ManageFieldsPanel } from "@/components/custom-fields/manage-fields-panel";
import { SharedOptionSetsPanel } from "@/components/custom-fields/shared-option-sets-panel";
import { toCustomFieldDefinitionData } from "@/lib/custom-field-definitions";
import { parseSelectOptions } from "@/lib/shared-field-options";
import { ManageSquadsPanel } from "@/components/squads/manage-squads-panel";
import { ManageMembersPanel } from "@/components/settings/manage-members-panel";
import { OrgReadOnlyAccessPanel } from "@/components/settings/org-readonly-access-panel";
import { ManageApiKeysPanel } from "@/components/settings/manage-api-keys-panel";
import { PortalSettingsPanel } from "@/components/settings/portal-settings-panel";
import { DeliveryLimitsPanel } from "@/components/settings/delivery-limits-panel";
import { WorkspaceBrandingPanel } from "@/components/settings/workspace-branding-panel";
import { ThinkingModelPanel } from "@/components/settings/thinking-model-panel";
import { inspectStoredLabels, resolveThinkingModel } from "@/lib/thinking-model/resolve";
import { DeleteWorkspacePanel } from "@/components/settings/delete-workspace-panel";
import { WorkspaceScoringPanel } from "@/components/scoring-models/workspace-scoring-panel";
import type { ApiKeyRow } from "@/components/settings/manage-api-keys-panel";
import type {
  CustomFieldDefinitionData,
  CustomFieldObjectType,
  SharedFieldOptionSetData,
  SquadData,
  MemberData,
} from "@/lib/types";
import { isOrgAdminRole, normalizeWorkspaceRole } from "@/lib/roles";
import { canChangeThinkingModel } from "@/lib/thinking-model/permissions";
import { PageHeader } from "@/components/patterns/page-header";
import { SettingsSection } from "@/components/patterns/settings-section";
import { CapabilityPacksPanel, type CapabilityPackSettingsRow } from "@/components/settings/capability-packs-panel";
import { ThemePreferenceControl } from "@/components/theme/theme-preference-control";
import { WorkspaceAgentsPanel } from "@/components/settings/workspace-agents-panel";
import { AgentActivity } from "@/components/settings/agent-activity";
import { invokedByForAgentActivity } from "@/lib/agent-activity";
import { agentsEnabledInWorkspace } from "@/lib/agent-access";
import type { AgentInvokePolicy } from "@/lib/agent-ownership";
import { loadConfiguredAgentRunCaps } from "@/lib/agent-limits";
import { agentKind, agentOwner, canInvokeAgent, isUserOwnedBy, listAgentsForWorkspace } from "@/lib/agent-ownership";
import { getStoredDefaultAgentIds } from "@/lib/agent-defaults";
import { allowedAgentModels } from "@/lib/agent-models";
import { AnalyticsSettingsPanel } from "@/components/analytics/analytics-settings-panel";
import { listConnections } from "@/lib/analytics/service";
import {
  FeedbackSourcesPanel,
  type ArtifactOption,
  type FeedbackSourceRow,
} from "@/components/settings/feedback-sources-panel";
import { resolveEmbedAuthMode } from "@/lib/embed-auth-mode";
import { optionalCompassUrl, trustedCompassBaseUrl } from "@/lib/compass-url";

export const metadata = { title: "Workspace Settings" };

type Props = {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
};

export default async function SettingsPage({ params }: Props) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { orgSlug, workspaceSlug } = await params;
  const prisma = getPrisma();

  const workspace = await prisma.workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug }, members: { some: { userId: session.user.id } } },
    select: {
      id: true,
      organizationId: true,
      organization: {
        select: {
          name: true,
          members: { where: { userId: session.user?.id }, select: { role: true } },
          memberWorkspaceReadOnlyAccess: true,
        },
      },
      name: true,
      feedbackEnabled: true,
      roadmapPublic: true,
      nowLimit: true,
      nextLimit: true,
      portalAuthRequired: true,
      artifactFeedbackPublic: true,
      ssoEnabled: true,
      ssoSecretEncrypted: true,
      ssoSecretUpdatedAt: true,
      brandingPaletteId: true,
      brandingPrimaryHex: true,
      brandingFontPresetId: true,
      brandingFontFamily: true,
      brandingLogoUrl: true,
      thinkingModel: true,
      thinkingModelLabels: true,
    },
  });

  if (!workspace) redirect("/dashboard");
  const workspaceAgentsEnabled = await agentsEnabledInWorkspace(workspace.id);

  const [rawFields, rawSharedOptionSets, rawSquads, rawApiKeys, rawMembers, rawScoringModels, scoringConfig, rawCapabilityPacks] = await Promise.all([
    prisma.customFieldDefinition.findMany({
      where: { workspaceId: workspace.id },
      orderBy: [{ objectType: "asc" }, { order: "asc" }],
      include: { sharedOptionSet: { select: { id: true, name: true, options: true } } },
    }),
    prisma.sharedFieldOptionSet.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { name: "asc" },
      include: {
        fields: {
          select: { id: true, name: true, objectType: true },
          orderBy: [{ objectType: "asc" }, { order: "asc" }],
        },
      },
    }),
    prisma.squad.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "asc" },
    }),
    session.user?.id
      ? prisma.apiKey.findMany({
          where: { userId: session.user.id, agentId: null },
          orderBy: { createdAt: "desc" },
        })
      : Promise.resolve([]),
    prisma.workspaceMember.findMany({
      where: { workspaceId: workspace.id },
      include: { user: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.scoringModel.findMany({
      where: { organizationId: workspace.organizationId, status: "ACTIVE" },
      select: { id: true, name: true, formulaType: true },
      orderBy: { name: "asc" },
    }),
    prisma.workspaceScoringConfig.findUnique({
      where: { workspaceId: workspace.id },
      select: { opportunityScoringModelId: true, solutionScoringModelId: true },
    }),
    prisma.workspaceCapabilityPack.findMany({
      where: { workspaceId: workspace.id },
      include: { capabilityPackVersion: { include: { capabilityPack: { include: { versions: { orderBy: { createdAt: "desc" } } } } } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const fields: CustomFieldDefinitionData[] = rawFields.map(toCustomFieldDefinitionData);

  const sharedOptionSets: SharedFieldOptionSetData[] = rawSharedOptionSets.map((set) => ({
    id: set.id,
    name: set.name,
    options: parseSelectOptions(set.options),
    fieldCount: set.fields.length,
    usedBy: set.fields.map((field) => ({
      id: field.id,
      name: field.name,
      objectType: field.objectType as CustomFieldObjectType,
    })),
    updatedAt: set.updatedAt.toISOString(),
  }));

  const squads: SquadData[] = rawSquads.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
  }));

  const apiKeys: ApiKeyRow[] = rawApiKeys.map((k) => ({
    id: k.id,
    name: k.name,
    keyPrefix: k.keyPrefix,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
    revokedAt: k.revokedAt,
  }));

  const members: MemberData[] = rawMembers.map((m) => ({
    id: m.id,
    userId: m.userId,
    email: m.user.email,
    name: m.user.name,
    role: normalizeWorkspaceRole(m.role),
  }));

  const currentUserMembershipId =
    rawMembers.find((m) => m.userId === session.user?.id)?.id ?? null;
  const currentWorkspaceRole = rawMembers.find((m) => m.userId === session.user?.id)?.role;
  const thinkingModel = resolveThinkingModel(workspace);
  // Same code path as the resolver: the form shows only what is actually applied,
  // and anything stored but not applied is surfaced rather than silently dropped.
  const storedLabels = inspectStoredLabels(workspace);
  const canManageCapabilityPacks = normalizeWorkspaceRole(currentWorkspaceRole) === "ADMIN" || isOrgAdminRole(workspace.organization.members[0]?.role);
  // Deliberately NOT combined with canManageCapabilityPacks/workspace-admin
  // above: the Organization section below controls
  // Organization.memberWorkspaceReadOnlyAccess, which reaches every
  // workspace the org owns, not just this one. A workspace admin who is not
  // also an org OWNER/ADMIN must not see or use it, even though they pass
  // every other admin gate on this page.
  const isOrgAdmin = isOrgAdminRole(workspace.organization.members[0]?.role);
  // A workspace member who is an admin of the workspace or org. An org admin who is only here through the read-only
  // fallback (no membership) cannot change it: updateThinkingModel would answer "Workspace not found".
  const canEditThinkingModel = canChangeThinkingModel({ workspaceRole: currentWorkspaceRole, orgRole: workspace.organization.members[0]?.role });
  const analyticsActor = { userId: session.user.id, purpose: "USER" as const, scopeWorkspaceId: workspace.id };
  const analyticsConnections = await listConnections(analyticsActor, workspace.id);
  const grants = await prisma.agentWorkspaceGrant.findMany({ where: { workspaceId: workspace.id, revokedAt: null } });
  const workspaceAgents = await listAgentsForWorkspace(prisma, workspace.id, { memberUserIds: rawMembers.map((m) => m.userId), grantedAgentIds: grants.map((g) => g.agentId), includeGrantable: canManageCapabilityPacks });
  // Only the cloud agents this viewer may edit are sent their limits, but one tolerant query covers the lot.
  const runCaps = await loadConfiguredAgentRunCaps(prisma, workspaceAgents.filter((a) => agentKind(a) === "CLOUD").map((a) => a.id));
  const storedDefaults = await getStoredDefaultAgentIds(prisma, { userId: session.user.id, workspaceId: workspace.id });
  const usableAgentIds = new Set((await Promise.all(workspaceAgents.map(async (a) => (agentKind(a) === "CLOUD" && a.status === "ACTIVE" && grants.some((g) => g.agentId === a.id) && (await canInvokeAgent(prisma, { userId: session.user!.id }, a)) ? a.id : null)))).filter((id): id is string => !!id));
  const agentActivity = canManageCapabilityPacks ? await prisma.agentToolCall.findMany({ where: { workspaceId: workspace.id }, orderBy: { createdAt: "desc" }, take: 25 }) : [];
  const agentActivityInvokedBy = await invokedByForAgentActivity(agentActivity);
  // Embed tokens are a public write credential, so the panel below is gated on
  // the same bar its server actions enforce (resolveWorkspaceAdmin: workspace
  // admin or org admin) — which is exactly what canManageCapabilityPacks is.
  // Skipping the queries for non-admins also keeps two round-trips off the page
  // for the majority of viewers who will never see the section.
  const [rawFeedbackSources, rawFeedbackArtifacts] = canManageCapabilityPacks
    ? await Promise.all([
        prisma.feedbackSource.findMany({
          where: { workspaceId: workspace.id },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            name: true,
            artifactId: true,
            allowedOrigins: true,
            enabled: true,
            authMode: true,
            artifact: { select: { title: true } },
            tokens: {
              orderBy: { createdAt: "asc" },
              select: {
                id: true,
                tokenPrefix: true,
                label: true,
                createdAt: true,
                lastUsedAt: true,
                revokedAt: true,
                expiresAt: true,
              },
            },
          },
        }),
        prisma.artifact.findMany({
          where: { workspaceId: workspace.id, status: "ACTIVE" },
          orderBy: { updatedAt: "desc" },
          select: { id: true, title: true },
        }),
      ])
    : [[], []];
  const feedbackSources: FeedbackSourceRow[] = rawFeedbackSources.map((source) => ({
    id: source.id,
    name: source.name,
    artifactId: source.artifactId,
    artifactTitle: source.artifact?.title ?? null,
    // `allowedOrigins` is a Json column; anything that is not an array of strings
    // did not come from normalizeAllowedOrigins and is not something the widget
    // would honor either, so it is dropped rather than rendered.
    allowedOrigins: Array.isArray(source.allowedOrigins)
      ? source.allowedOrigins.filter((entry): entry is string => typeof entry === "string")
      : [],
    enabled: source.enabled,
    // Normalized here rather than in the panel, so the client never has to decide
    // what a NULL means. A row written before this column existed reads as
    // INTERNAL_SSO — see lib/embed-auth-mode.ts for why that is the safe default.
    authMode: resolveEmbedAuthMode(source.authMode),
    tokens: source.tokens,
  }));
  const feedbackArtifacts: ArtifactOption[] = rawFeedbackArtifacts;
  // Resolved here rather than from window.location so the first client render
  // matches the server's, and optional because a deployment without a configured
  // URL should still render the panel — just without a copyable snippet.
  const embedBaseUrl = optionalCompassUrl(() => trustedCompassBaseUrl().origin);

  const capabilityPacks: CapabilityPackSettingsRow[] = rawCapabilityPacks.map((attachment) => ({
    packId: attachment.capabilityPackVersion.capabilityPack.packId,
    sourceRepository: attachment.capabilityPackVersion.sourceRepository,
    sourcePath: attachment.capabilityPackVersion.sourcePath,
    displayName: attachment.capabilityPackVersion.capabilityPack.displayName,
    enabled: attachment.enabled,
    selectedVersionId: attachment.capabilityPackVersionId,
    enabledSkillIds: JSON.parse(attachment.enabledSkillIds) as string[],
    versions: attachment.capabilityPackVersion.capabilityPack.versions.map((version) => ({
      id: version.id, version: version.semanticVersion, commit: version.sourceCommit, digest: version.artifactSha256,
      skills: (JSON.parse(version.manifestJson) as { skills: Array<{ id: string; enabledByDefault?: boolean }> }).skills,
    })),
  }));

  return (
    <main className="flex w-full min-w-0 flex-1 flex-col gap-8 p-4 sm:p-6 md:max-w-3xl md:p-8">
      <PageHeader title="Settings" description={workspace.name} />

      <SettingsSection title="Appearance" description="Choose how Compass looks on this device. System follows your operating system setting.">
        <ThemePreferenceControl />
      </SettingsSection>

      <SettingsSection title="Squads" description={`Teams within this workspace. Squads can be assigned to ${thinkingModel.labels.objective.lowerPlural}, ${thinkingModel.labels.opportunity.lowerPlural}, experiments, and roadmap items.`}>
        <ManageSquadsPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          initialSquads={squads}
        />
      </SettingsSection>

      <SettingsSection title="Members" description="People with access to this workspace. Admins can manage settings, squads, and members; members have standard access.">
        <ManageMembersPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          initialMembers={members}
          currentUserMembershipId={currentUserMembershipId}
        />
      </SettingsSection>

      {isOrgAdmin && (
        <SettingsSection
          title="Organization"
          description={`Settings here apply to the whole "${workspace.organization.name ?? "organization"}" organization — every workspace it owns, not just ${workspace.name}. Visible only to organization owners/admins.`}
        >
          <OrgReadOnlyAccessPanel
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            memberWorkspaceReadOnlyAccess={workspace.organization.memberWorkspaceReadOnlyAccess ?? false}
          />
        </SettingsSection>
      )}

      <SettingsSection title="Shared option sets" description="One editable picklist that any select or multi-select field can borrow — across different object types. Edit the list here and every field using it updates at once.">
        <SharedOptionSetsPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          sets={sharedOptionSets}
        />
      </SettingsSection>

      <SettingsSection title="Custom Fields" description="Add fields to any object type. Click any field value on a record to edit it. Select fields can draw their options from a shared option set instead of keeping their own list.">
        <ManageFieldsPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          initialFields={fields}
          sharedOptionSets={sharedOptionSets}
        />
      </SettingsSection>

      <SettingsSection title="Scoring" description={`Choose which org-level scoring model this workspace uses to rank ${thinkingModel.labels.opportunity.plural} and ${thinkingModel.labels.solution.plural}. The two picks are independent of each other. Templates are managed by organization admins in Org Settings.`}>
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">{thinkingModel.labels.opportunity.plural}</p>
            <WorkspaceScoringPanel
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              entityType="OPPORTUNITY"
              availableModels={rawScoringModels}
              currentScoringModelId={scoringConfig?.opportunityScoringModelId ?? null}
            />
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">{thinkingModel.labels.solution.plural}</p>
            <WorkspaceScoringPanel
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              entityType="SOLUTION"
              availableModels={rawScoringModels}
              currentScoringModelId={scoringConfig?.solutionScoringModelId ?? null}
            />
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="API Keys" description="Generate personal API keys for MCP / programmatic access. Each key is tied to your account and can be revoked independently.">
        <ManageApiKeysPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          initialKeys={apiKeys}
        />
      </SettingsSection>

      <SettingsSection title="Analytics" description="Bring aggregate usage evidence into product decisions without exposing credentials or customer identities.">
        <AnalyticsSettingsPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          initialConnections={analyticsConnections}
          canManage={canManageCapabilityPacks}
        />
      </SettingsSection>

      <SettingsSection title="Workspace agents" description="Agents explicitly authorized in this workspace, including cloud agents that run inside Compass. Assignment does not grant access; assigning a task to a cloud agent from the app starts a run, within the limits set on that agent.">
        <WorkspaceAgentsPanel orgSlug={orgSlug} workspaceSlug={workspaceSlug} enabled={workspaceAgentsEnabled} canManage={canManageCapabilityPacks} models={allowedAgentModels()} agents={workspaceAgents.map((a) => {
          const owner = agentOwner(a);
          const ownerMember = owner?.type === "USER" ? rawMembers.find((m) => m.userId === owner.userId) : undefined;
          // Editing follows canManageAgent: the owner of a personal agent, an administrator for a shared one. Only editors receive the instructions.
          const canEdit = owner?.type === "WORKSPACE" ? canManageCapabilityPacks : isUserOwnedBy(a, session.user!.id);
          return {
            id: a.id, name: a.name, status: a.status,
            ownerName: owner?.type === "WORKSPACE" ? "Shared" : ownerMember?.user.name ?? ownerMember?.user.email ?? "Former member",
            eligible: owner?.type === "WORKSPACE" || !!ownerMember,
            access: grants.find((g) => g.agentId === a.id)?.access ?? null,
            kind: agentKind(a), shared: owner?.type === "WORKSPACE", description: a.description ?? null,
            ...(canEdit && agentKind(a) === "CLOUD" ? { instructions: a.instructions ?? null, model: a.model ?? null, invokePolicy: (a.invokePolicy as AgentInvokePolicy | null) ?? null, ...(runCaps.get(a.id) ?? {}) } : {}),
            canEdit: canEdit && agentKind(a) === "CLOUD",
            canUse: usableAgentIds.has(a.id),
            isWorkspaceDefault: storedDefaults.workspaceDefaultAgentId === a.id,
            isMyDefault: storedDefaults.userDefaultAgentId === a.id,
          };
        })} />
      </SettingsSection>
      {canManageCapabilityPacks && <SettingsSection title="Workspace agent activity"><AgentActivity rows={agentActivity.map((r) => ({ ...r, invokedByName: agentActivityInvokedBy.get(r) ?? null, agentName: workspaceAgents.find((a) => a.id === r.agentId)?.name ?? "Former workspace agent", workspaceName: workspace.name }))} /></SettingsSection>}

      {canManageCapabilityPacks && <SettingsSection title="Agent capability packs" description="Install validated skills-only packs for the in-app agent. Packs add instructions, never tools or credentials.">
        <CapabilityPacksPanel orgSlug={orgSlug} workspaceSlug={workspaceSlug} initialPacks={capabilityPacks} />
      </SettingsSection>}

      <SettingsSection title="Delivery limits" description="Optional WIP limits for the NOW and NEXT roadmap columns.">
        <DeliveryLimitsPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          nowLimit={workspace.nowLimit ?? null}
          nextLimit={workspace.nextLimit ?? null}
        />
      </SettingsSection>

      <SettingsSection title="Portal" description="Control which parts of this workspace are publicly accessible without login.">
        <PortalSettingsPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          feedbackEnabled={workspace.feedbackEnabled ?? false}
          roadmapPublic={workspace.roadmapPublic ?? false}
          portalAuthRequired={workspace.portalAuthRequired ?? false}
          ssoEnabled={workspace.ssoEnabled ?? false}
          ssoSecretConfigured={Boolean(workspace.ssoSecretEncrypted)}
          ssoSecretUpdatedAt={workspace.ssoSecretUpdatedAt}
        />
      </SettingsSection>

      {/* Links to the Modules page. No switch here, so it cannot shift the positional switch indices the Portal specs rely on. */}
      <SettingsSection title="Modules" description="Turn product modules on or off for this workspace: research, voice, notifications, agents, the marketing launch workflow and more. Workspace administrators only.">
        <Button variant="outline" render={<Link href={`/${orgSlug}/${workspaceSlug}/settings/modules`} />}>Manage modules</Button>
      </SettingsSection>

      {/*
        Also after Portal, for the positional-index reason documented above: this
        section's per-source toggles would otherwise shift the indices those
        specs rely on.
      */}
      {canManageCapabilityPacks && <SettingsSection title="Embedded feedback" description="Let a prototype hosted elsewhere collect element-anchored feedback against an artifact in this workspace. Each source carries its own token and its own list of sites allowed to use it.">
        <FeedbackSourcesPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          initialSources={feedbackSources}
          artifacts={feedbackArtifacts}
          embedBaseUrl={embedBaseUrl}
          artifactFeedbackPublic={workspace.artifactFeedbackPublic ?? false}
          ssoIdentifyEnabled={workspace.ssoEnabled ?? false}
        />
      </SettingsSection>}

      {/* Admin only, enforced again by updateThinkingModel (resolveWorkspaceAdmin).
          Has no switches, so its position cannot shift the positional-index specs. */}
      {canEditThinkingModel && (
        <SettingsSection title="Thinking model" description="What this workspace calls its goals and measures. Names only: your data is the same under every choice, so you can switch back at any time.">
          <ThinkingModelPanel
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            initialKey={thinkingModel.key}
            initialOverrides={storedLabels.applied}
            unappliedStored={storedLabels.unapplied}
          />
        </SettingsSection>
      )}

      <SettingsSection title="Branding" description="Customize the accent color, font, and logo shown across this workspace and its public portal.">
        <WorkspaceBrandingPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          initialPaletteId={workspace.brandingPaletteId}
          initialPrimaryHex={workspace.brandingPrimaryHex}
          initialFontPresetId={workspace.brandingFontPresetId}
          initialFontFamily={workspace.brandingFontFamily}
          initialLogoUrl={workspace.brandingLogoUrl}
        />
      </SettingsSection>

      <SettingsSection danger title="Danger Zone" description="Destructive actions that cannot be undone.">
        <DeleteWorkspacePanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          workspaceName={workspace.name}
        />
      </SettingsSection>
    </main>
  );
}
