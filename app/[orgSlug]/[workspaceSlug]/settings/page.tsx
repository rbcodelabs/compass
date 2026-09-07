import { redirect } from "next/navigation";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { ManageFieldsPanel } from "@/components/custom-fields/manage-fields-panel";
import { ManageSquadsPanel } from "@/components/squads/manage-squads-panel";
import { ManageMembersPanel } from "@/components/settings/manage-members-panel";
import { ManageApiKeysPanel } from "@/components/settings/manage-api-keys-panel";
import { PortalSettingsPanel } from "@/components/settings/portal-settings-panel";
import { WorkspaceBrandingPanel } from "@/components/settings/workspace-branding-panel";
import { DeleteWorkspacePanel } from "@/components/settings/delete-workspace-panel";
import { WorkspaceScoringPanel } from "@/components/scoring-models/workspace-scoring-panel";
import type { ApiKeyRow } from "@/components/settings/manage-api-keys-panel";
import type {
  CustomFieldDefinitionData,
  CustomFieldObjectType,
  CustomFieldType,
  SquadData,
  MemberData,
} from "@/lib/types";
import { isOrgAdminRole, normalizeWorkspaceRole } from "@/lib/roles";
import { PageHeader } from "@/components/patterns/page-header";
import { SettingsSection } from "@/components/patterns/settings-section";
import { CapabilityPacksPanel, type CapabilityPackSettingsRow } from "@/components/settings/capability-packs-panel";
import { ThemePreferenceControl } from "@/components/theme/theme-preference-control";

export const metadata = { title: "Workspace Settings" };

type Props = {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
};

export default async function SettingsPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { orgSlug, workspaceSlug } = await params;
  const prisma = getPrisma();

  const workspace = await prisma.workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug } },
    select: {
      id: true,
      organizationId: true,
      organization: { select: { members: { where: { userId: session.user?.id }, select: { role: true } } } },
      name: true,
      feedbackEnabled: true,
      roadmapPublic: true,
      portalAuthRequired: true,
      ssoEnabled: true,
      ssoSecretEncrypted: true,
      ssoSecretUpdatedAt: true,
      brandingPaletteId: true,
      brandingPrimaryHex: true,
      brandingFontPresetId: true,
      brandingFontFamily: true,
      brandingLogoUrl: true,
    },
  });

  if (!workspace) redirect("/dashboard");

  const [rawFields, rawSquads, rawApiKeys, rawMembers, rawScoringModels, scoringConfig, rawCapabilityPacks] = await Promise.all([
    prisma.customFieldDefinition.findMany({
      where: { workspaceId: workspace.id },
      orderBy: [{ objectType: "asc" }, { order: "asc" }],
    }),
    prisma.squad.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "asc" },
    }),
    session.user?.id
      ? prisma.apiKey.findMany({
          where: { userId: session.user.id },
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
      select: { scoringModelId: true },
    }),
    prisma.workspaceCapabilityPack.findMany({
      where: { workspaceId: workspace.id },
      include: { capabilityPackVersion: { include: { capabilityPack: { include: { versions: { orderBy: { createdAt: "desc" } } } } } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const fields: CustomFieldDefinitionData[] = rawFields.map((f) => ({
    id: f.id,
    name: f.name,
    fieldType: f.fieldType as CustomFieldType,
    objectType: f.objectType as CustomFieldObjectType,
    options: f.options as CustomFieldDefinitionData["options"],
    required: f.required,
    order: f.order,
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
  const canManageCapabilityPacks = normalizeWorkspaceRole(currentWorkspaceRole) === "ADMIN" || isOrgAdminRole(workspace.organization.members[0]?.role);
  const capabilityPacks: CapabilityPackSettingsRow[] = rawCapabilityPacks.map((attachment) => ({
    packId: attachment.capabilityPackVersion.capabilityPack.packId,
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

      <SettingsSection title="Squads" description="Teams within this workspace. Squads can be assigned to objectives, opportunities, experiments, and roadmap items.">
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

      <SettingsSection title="Custom Fields" description="Add fields to any object type. Click any field value on a record to edit it.">
        <ManageFieldsPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          initialFields={fields}
        />
      </SettingsSection>

      <SettingsSection title="Scoring" description="Choose which org-level scoring model this workspace uses to rank opportunities. Templates are managed by organization admins in Org Settings.">
        <WorkspaceScoringPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          availableModels={rawScoringModels}
          currentScoringModelId={scoringConfig?.scoringModelId ?? null}
        />
      </SettingsSection>

      <SettingsSection title="API Keys" description="Generate personal API keys for MCP / programmatic access. Each key is tied to your account and can be revoked independently.">
        <ManageApiKeysPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          initialKeys={apiKeys}
        />
      </SettingsSection>

      {canManageCapabilityPacks && <SettingsSection title="Agent capability packs" description="Install validated skills-only packs for the in-app agent. Packs add instructions, never tools or credentials.">
        <CapabilityPacksPanel orgSlug={orgSlug} workspaceSlug={workspaceSlug} initialPacks={capabilityPacks} />
      </SettingsSection>}

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
