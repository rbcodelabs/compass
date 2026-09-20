import { notFound } from "next/navigation";
import getPrisma from "@/lib/db";
import { ManageScoringModelsPanel } from "@/components/scoring-models/manage-scoring-models-panel";
import { DeleteOrganizationPanel } from "@/components/settings/delete-organization-panel";
import { CreateWorkspacePanel } from "@/components/settings/create-workspace-panel";
import type { ScoringModelData, ScoringModelStatus, ScoringFormulaType, MetricDirection } from "@/lib/types";
import { PageHeader } from "@/components/patterns/page-header";
import { SettingsSection } from "@/components/patterns/settings-section";

export const metadata = { title: "Organization Settings" };

type Props = {
  params: Promise<{ orgSlug: string }>;
};

export default async function OrgSettingsPage({ params }: Props) {
  const { orgSlug } = await params;
  const prisma = getPrisma();

  const organization = await prisma.organization.findUnique({
    where: { slug: orgSlug },
    select: { id: true, name: true },
  });

  // Access is already gated by app/[orgSlug]/settings/layout.tsx (org admin
  // required to reach this route at all) — this null-check only covers the
  // org-doesn't-exist case, matching the workspace settings page's
  // redirect-if-missing convention.
  if (!organization) notFound();

  const rawModels = await prisma.scoringModel.findMany({
    where: { organizationId: organization.id },
    include: { metrics: { orderBy: { order: "asc" } } },
    orderBy: { createdAt: "asc" },
  });

  // `id`/`slug` are for the Workspaces section below; DeleteOrganizationPanel
  // only reads `name`.
  const workspaces = await prisma.workspace.findMany({
    where: { organizationId: organization.id },
    select: { id: true, name: true, slug: true },
    orderBy: { name: "asc" },
  });

  const models: ScoringModelData[] = rawModels.map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    status: m.status as ScoringModelStatus,
    formulaType: m.formulaType as ScoringFormulaType,
    version: m.version,
    metrics: m.metrics.map((metric) => ({
      id: metric.id,
      key: metric.key,
      label: metric.label,
      description: metric.description,
      minValue: metric.minValue,
      maxValue: metric.maxValue,
      weight: metric.weight,
      direction: metric.direction as MetricDirection,
      order: metric.order,
    })),
  }));

  return (
    <main className="flex flex-col flex-1 p-4 sm:p-6 md:p-8 gap-8 max-w-3xl">
      <PageHeader title="Organization Settings" description={organization.name} />

      <SettingsSection
        title="Workspaces"
        description="Workspaces are where teams run OKRs, discovery, and experiments. Creating one adds every member of this organization to it."
      >
        <CreateWorkspacePanel orgSlug={orgSlug} workspaces={workspaces} />
      </SettingsSection>

      <SettingsSection
        title="Scoring Models"
        description="Named templates (e.g. RICE, ICE) that workspaces can select to score and rank opportunities. Every workspace using a given model is comparable on the same 0–100 scale, even after the template is edited later."
      >
        <ManageScoringModelsPanel orgSlug={orgSlug} initialModels={models} />
      </SettingsSection>

      <SettingsSection
        title="Danger Zone"
        description="Permanently delete this organization and every workspace and record it contains. This action is irreversible."
        danger
      >
        <DeleteOrganizationPanel
          orgSlug={orgSlug}
          organizationName={organization.name}
          workspaces={workspaces}
        />
      </SettingsSection>
    </main>
  );
}
