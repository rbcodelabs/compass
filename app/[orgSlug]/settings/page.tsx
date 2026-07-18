import { notFound } from "next/navigation";
import getPrisma from "@/lib/db";
import { ManageScoringModelsPanel } from "@/components/scoring-models/manage-scoring-models-panel";
import type { ScoringModelData, ScoringModelStatus, ScoringFormulaType, MetricDirection } from "@/lib/types";

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
      <div>
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900">
          Organization Settings
        </h1>
        <p className="text-sm text-slate-500 mt-1">{organization.name}</p>
      </div>

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-base font-semibold">Scoring Models</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Named templates (e.g. RICE, ICE) that workspaces can select to score and rank
            opportunities. Every workspace using a given model is comparable on the same 0–100
            scale, even after the template is edited later.
          </p>
        </div>

        <ManageScoringModelsPanel orgSlug={orgSlug} initialModels={models} />
      </section>
    </main>
  );
}
