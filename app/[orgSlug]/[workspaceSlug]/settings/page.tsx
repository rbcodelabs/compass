import { redirect } from "next/navigation";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { ManageFieldsPanel } from "@/components/custom-fields/manage-fields-panel";
import { ManageSquadsPanel } from "@/components/squads/manage-squads-panel";
import { ManageMembersPanel } from "@/components/settings/manage-members-panel";
import { ManageApiKeysPanel } from "@/components/settings/manage-api-keys-panel";
import { PortalSettingsPanel } from "@/components/settings/portal-settings-panel";
import { DeleteWorkspacePanel } from "@/components/settings/delete-workspace-panel";
import type { ApiKeyRow } from "@/components/settings/manage-api-keys-panel";
import type {
  CustomFieldDefinitionData,
  CustomFieldObjectType,
  CustomFieldType,
  SquadData,
  MemberData,
} from "@/lib/types";

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
    select: { id: true, name: true, feedbackEnabled: true, roadmapPublic: true },
  });

  if (!workspace) redirect("/dashboard");

  const [rawFields, rawSquads, rawApiKeys, rawMembers] = await Promise.all([
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
    role: m.role as MemberData["role"],
  }));

  const currentUserMembershipId =
    rawMembers.find((m) => m.userId === session.user?.id)?.id ?? null;

  return (
    <main className="flex flex-col flex-1 p-4 sm:p-6 md:p-8 gap-8 max-w-3xl">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900">Settings</h1>
        <p className="text-sm text-slate-500 mt-1">{workspace.name}</p>
      </div>

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-base font-semibold">Squads</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Teams within this workspace. Squads can be assigned to objectives, opportunities, experiments, and roadmap items.
          </p>
        </div>

        <ManageSquadsPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          initialSquads={squads}
        />
      </section>

      <div className="border-t border-border" />

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-base font-semibold">Members</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            People with access to this workspace. Admins can manage settings, squads, and members; members have standard access.
          </p>
        </div>

        <ManageMembersPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          initialMembers={members}
          currentUserMembershipId={currentUserMembershipId}
        />
      </section>

      <div className="border-t border-border" />

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-base font-semibold">Custom Fields</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Add fields to any object type. Click any field value on a record to edit it.
          </p>
        </div>

        <ManageFieldsPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          initialFields={fields}
        />
      </section>

      <div className="border-t border-border" />

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-base font-semibold">API Keys</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Generate personal API keys for MCP / programmatic access. Each key is tied to your account and can be revoked independently.
          </p>
        </div>

        <ManageApiKeysPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          initialKeys={apiKeys}
        />
      </section>

      <div className="border-t border-border" />

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-base font-semibold">Portal</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Control which parts of this workspace are publicly accessible without login.
          </p>
        </div>

        <PortalSettingsPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          feedbackEnabled={workspace.feedbackEnabled ?? false}
          roadmapPublic={workspace.roadmapPublic ?? false}
        />
      </section>

      <div className="border-t border-border" />

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-base font-semibold text-red-600">Danger Zone</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Destructive actions that cannot be undone.
          </p>
        </div>

        <DeleteWorkspacePanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          workspaceName={workspace.name}
        />
      </section>
    </main>
  );
}
