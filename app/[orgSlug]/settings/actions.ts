"use server";

import { revalidatePath } from "next/cache";
import { resolveOrgAdmin } from "@/lib/permissions";
import { validateMetricsForFormula } from "@/lib/scoring";
import type { ScoringFormulaType, MetricDirection } from "@/lib/types";

export interface ScoringMetricInput {
  key: string;
  label: string;
  description?: string;
  minValue: number;
  maxValue: number;
  weight: number;
  direction: MetricDirection;
}

// ─── Scoring Models (org admin only) ──────────────────────────────────────────

export async function createScoringModel(
  orgSlug: string,
  input: {
    name: string;
    description?: string;
    formulaType: ScoringFormulaType;
    metrics: ScoringMetricInput[];
  }
) {
  const { prisma, organizationId } = await resolveOrgAdmin(orgSlug);

  validateMetricsForFormula(input.metrics, input.formulaType);

  const model = await prisma.scoringModel.create({
    data: {
      organizationId,
      name: input.name,
      description: input.description,
      formulaType: input.formulaType,
    },
  });

  if (input.metrics.length > 0) {
    await prisma.scoringModelMetric.createMany({
      data: input.metrics.map((m, i) => ({
        scoringModelId: model.id,
        key: m.key,
        label: m.label,
        description: m.description,
        minValue: m.minValue,
        maxValue: m.maxValue,
        weight: m.weight,
        direction: m.direction,
        order: i,
      })),
    });
  }

  revalidatePath(`/${orgSlug}/settings`);
  return model;
}

/**
 * Updates a scoring model's name/description only — does NOT bump version.
 * Per the versioning decision, only metric/formula-shape edits bump version.
 */
export async function updateScoringModelDetails(
  orgSlug: string,
  scoringModelId: string,
  input: { name?: string; description?: string }
) {
  const { prisma } = await resolveOrgAdmin(orgSlug);

  await prisma.scoringModel.update({
    where: { id: scoringModelId },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      updatedAt: new Date(),
    },
  });

  revalidatePath(`/${orgSlug}/settings`);
}

/**
 * Replaces a scoring model's metrics (and optionally its formula type) and
 * bumps ScoringModel.version. Existing OpportunityScore rows are untouched —
 * they carry their own formulaSnapshot and stay frozen to the version that
 * produced them until someone re-scores that opportunity.
 *
 * Full delete+recreate of the metric rows (rather than diffing) is safe
 * because OpportunityScore.formulaSnapshot is a self-contained JSON copy,
 * not a foreign key to ScoringModelMetric rows.
 */
export async function updateScoringModelMetrics(
  orgSlug: string,
  scoringModelId: string,
  input: { formulaType?: ScoringFormulaType; metrics: ScoringMetricInput[] }
) {
  const { prisma } = await resolveOrgAdmin(orgSlug);

  const existing = await prisma.scoringModel.findUnique({
    where: { id: scoringModelId },
    select: { formulaType: true, version: true },
  });
  if (!existing) throw new Error("Scoring model not found");

  const formulaType = input.formulaType ?? (existing.formulaType as ScoringFormulaType);
  validateMetricsForFormula(input.metrics, formulaType);

  await prisma.scoringModelMetric.deleteMany({ where: { scoringModelId } });

  if (input.metrics.length > 0) {
    await prisma.scoringModelMetric.createMany({
      data: input.metrics.map((m, i) => ({
        scoringModelId,
        key: m.key,
        label: m.label,
        description: m.description,
        minValue: m.minValue,
        maxValue: m.maxValue,
        weight: m.weight,
        direction: m.direction,
        order: i,
      })),
    });
  }

  await prisma.scoringModel.update({
    where: { id: scoringModelId },
    data: {
      formulaType,
      version: existing.version + 1,
      updatedAt: new Date(),
    },
  });

  revalidatePath(`/${orgSlug}/settings`);
}

/**
 * Archive-only "delete". ScoringModel is never hard-deleted in v1 — see
 * schema comment: OpportunityScore/WorkspaceScoringConfig rows may reference
 * it and relationMode="prisma" (DSQL, no FK cascade) means the DB won't
 * protect against orphaning them.
 */
export async function archiveScoringModel(orgSlug: string, scoringModelId: string) {
  const { prisma } = await resolveOrgAdmin(orgSlug);

  await prisma.scoringModel.update({
    where: { id: scoringModelId },
    data: { status: "ARCHIVED", updatedAt: new Date() },
  });

  revalidatePath(`/${orgSlug}/settings`);
}
