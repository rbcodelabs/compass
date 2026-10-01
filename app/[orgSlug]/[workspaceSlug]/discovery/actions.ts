"use server";

import { captureWorkspaceMutation } from "@/lib/workspace-update-mutations"
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { requireProductEntity, requireProductWorkspace, requireProductWorkspaceBySlug } from "@/lib/product-action-auth";
import { OpportunityCreateError, createOpportunityWithLinks, type NewOpportunityInput } from "@/lib/opportunity-create";
import { getHumanActivityPrisma as getPrisma } from "@/lib/analytics/activity";
import { setOpportunityKeyResult } from "@/lib/typed-links";
import { loadThinkingModelSource } from "@/lib/thinking-model/link-surfaces";
import { resolveThinkingModel } from "@/lib/thinking-model/resolve";
import { Prisma } from "@prisma/client";
import { deleteMirroredComment, mirrorLegacySolutionComment, updateMirroredComment, updateMirroredLegacyPlanStatus } from "@/lib/comment-compat";
import { computeScore, validateMetricsForFormula, type ScoringMetricDef } from "@/lib/scoring";
import { toCustomFieldDefinitionData } from "@/lib/custom-field-definitions";
import { validateOpportunityFieldMove } from "@/lib/opportunity-field-board";
import type {
  OpportunityStatus,
  SolutionStatus,
  AssumptionStatus,
  RiskLevel,
  ScoringFormulaType,
  MetricDirection,
  FormulaSnapshotMetric,
  EvidenceSourceType,
  EvidenceConfidence,
  CommentType,
  PlanStatus,
  SquadData,
} from "@/lib/types";

// Types live in @/lib/types — import from there directly.

/**
 * Creates an opportunity, optionally with its Key Result and the feedback
 * items that seeded it, in one transaction (see lib/opportunity-create.ts).
 * Throws on invalid input or a link outside the workspace.
 */
export async function createOpportunity(workspaceId: string, data: NewOpportunityInput) {
  await requireProductWorkspace(workspaceId);
  const opportunity = await createOpportunityWithLinks(getPrisma(), workspaceId, data);
  revalidatePath(`/[orgSlug]/[workspaceSlug]/discovery`, "page");
  return opportunity;
}

export type CreateOpportunityFromComposerResult =
  | { ok: true; opportunity: { id: string; title: string } }
  | { ok: false; error: string };

/**
 * The "New opportunity" composer's submit. Addressed by slug (the panel only
 * knows the URL) with membership resolved server-side, and it reports
 * failures as values so the composer can show them inline and keep the draft.
 * Nothing is written unless the opportunity and every link are valid.
 */
export async function createOpportunityFromComposer(
  orgSlug: string,
  workspaceSlug: string,
  data: NewOpportunityInput
): Promise<CreateOpportunityFromComposerResult> {
  let workspaceId: string;
  try {
    workspaceId = await requireProductWorkspaceBySlug(orgSlug, workspaceSlug);
  } catch {
    return { ok: false, error: "Workspace not found or you no longer have access to it." };
  }
  try {
    // Attribution for any Objective links chosen in the composer (null for an unattributed session).
    const session = data.objectiveIds?.length ? await auth() : null;
    const opportunity = await createOpportunityWithLinks(getPrisma(), workspaceId, data, { createdById: session?.user?.id ?? null });
    revalidatePath(`/[orgSlug]/[workspaceSlug]/discovery`, "layout");
    if (data.feedbackIds?.length) revalidatePath(`/${orgSlug}/${workspaceSlug}/feedback`);
    if (data.objectiveIds?.length) revalidatePath(`/${orgSlug}/${workspaceSlug}/okrs`);
    return { ok: true, opportunity: { id: opportunity.id, title: opportunity.title } };
  } catch (error) {
    if (error instanceof OpportunityCreateError) return { ok: false, error: error.message };
    // A failed objective link (including a missing link table) rolled the whole create back. Fail loudly but generically:
    // log only the error name and code (a database error message can carry row data) and keep the draft.
    if (data.objectiveIds?.length) {
      const e = error as { name?: string; code?: string } | null;
      console.error(JSON.stringify({ event: "opportunity_composer.link_failed", name: e?.name ?? "Error", code: e?.code ?? null }));
      return { ok: false, error: "Something went wrong. Nothing was created. Please try again." };
    }
    throw error;
  }
}

export type OpportunityComposerOptions = {
  squads: SquadData[];
  keyResults: { id: string; title: string; objectiveTitle: string }[];
  feedback: {
    id: string;
    title: string;
    type: string;
    status: string;
    opportunity: { id: string; title: string } | null;
  }[];
  /**
   * Objectives the composer may link (Phase 4B). Present only for presets whose composer offers the Opportunity<->Objective
   * link (links.oppToObjective "primary"); CLASSIC reads nothing extra and the field is omitted.
   */
  objectives?: { id: string; title: string; cycleTitle: string | null }[];
};

/** How many recent feedback items the composer's "Seed from feedback" picker searches. */
const COMPOSER_FEEDBACK_LIMIT = 500;

/**
 * What the composer's pickers choose from: the workspace's squads, its Key
 * Results (same query and shape as the opportunity panel's KR picker) and its
 * most recent feedback, each with the opportunity it is already linked to.
 */
export async function loadOpportunityComposerOptions(
  orgSlug: string,
  workspaceSlug: string
): Promise<{ ok: true; options: OpportunityComposerOptions } | { ok: false; error: string }> {
  let workspaceId: string;
  try {
    workspaceId = await requireProductWorkspaceBySlug(orgSlug, workspaceSlug);
  } catch {
    return { ok: false, error: "Workspace not found or you no longer have access to it." };
  }
  const prisma = getPrisma();
  // Display decision only: whether the composer offers the Objective picker. Nothing else depends on the preset.
  const offersObjectives = resolveThinkingModel(await loadThinkingModelSource(prisma, workspaceId)).links.oppToObjective === "primary";
  const [squads, keyResults, feedback, objectives] = await Promise.all([
    prisma.squad.findMany({ where: { workspaceId }, select: { id: true, name: true, color: true }, orderBy: { createdAt: "asc" } }),
    prisma.keyResult.findMany({
      where: { objective: { workspaceId } },
      select: { id: true, title: true, objective: { select: { title: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.feedbackItem.findMany({
      where: { workspaceId },
      select: { id: true, title: true, type: true, status: true, opportunity: { select: { id: true, title: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: COMPOSER_FEEDBACK_LIMIT,
    }),
    // Filtered on the Objective's own workspaceId, so a NULL / drifted row is never offered.
    offersObjectives
      ? prisma.objective.findMany({
          where: { workspaceId },
          select: { id: true, title: true, cycle: { select: { title: true } } },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        })
      : Promise.resolve(null),
  ]);
  return {
    ok: true,
    options: {
      squads,
      keyResults: keyResults.map((kr) => ({ id: kr.id, title: kr.title, objectiveTitle: kr.objective.title })),
      feedback,
      ...(objectives ? { objectives: objectives.map((o) => ({ id: o.id, title: o.title, cycleTitle: o.cycle?.title ?? null })) } : {}),
    },
  };
}

export async function updateOpportunityStatus(
  opportunityId: string,
  status: OpportunityStatus,
  revalidatePathStr: string
) {
  await requireProductEntity("opportunity", opportunityId);
  const prisma = getPrisma();
  const opportunity = await captureWorkspaceMutation(prisma, "opportunity", "update", "UI", opportunityId, tx => tx.opportunity.update({
    where: { id: opportunityId },
    data: { status },
  }));
  revalidatePath(revalidatePathStr);
  return opportunity;
}

export async function addSolution(
  opportunityId: string,
  data: { title: string; description?: string },
  revalidatePathStr: string
) {
  // The Solution's workspace is derived from the authorized parent Opportunity,
  // never from client input.
  const { workspaceId } = await requireProductEntity("opportunity", opportunityId);
  const prisma = getPrisma();
  const solution = await captureWorkspaceMutation(prisma, "solution", "create", "UI", undefined, tx => tx.solution.create({
    data: {
      workspaceId,
      opportunityId,
      title: data.title,
      description: data.description,
    },
  }));
  revalidatePath(revalidatePathStr);
  return solution;
}

export async function updateSolutionStatus(
  solutionId: string,
  status: SolutionStatus,
  revalidatePathStr: string
) {
  await requireProductEntity("solution", solutionId);
  const prisma = getPrisma();
  const solution = await captureWorkspaceMutation(prisma, "solution", "update", "UI", solutionId, tx => tx.solution.update({
    where: { id: solutionId },
    data: { status },
  }));
  revalidatePath(revalidatePathStr);
  return solution;
}

export async function addAssumption(
  solutionId: string,
  data: { title: string; riskLevel: RiskLevel },
  revalidatePathStr: string
) {
  const prisma = getPrisma();
  const assumption = await captureWorkspaceMutation(prisma, "assumption", "create", "UI", undefined, tx => tx.assumption.create({
    data: {
      solutionId,
      title: data.title,
      riskLevel: data.riskLevel,
    },
  }));
  revalidatePath(revalidatePathStr);
  return assumption;
}

export async function updateAssumptionStatus(
  assumptionId: string,
  status: AssumptionStatus,
  revalidatePathStr: string
) {
  const prisma = getPrisma();
  const assumption = await captureWorkspaceMutation(prisma, "assumption", "update", "UI", assumptionId, tx => tx.assumption.update({
    where: { id: assumptionId },
    data: { status },
  }));
  revalidatePath(revalidatePathStr);
  return assumption;
}

export async function linkOpportunityToKeyResult(
  opportunityId: string,
  keyResultId: string | null,
  revalidatePathStr: string
) {
  // A server action is a public POST endpoint: both ends need the caller's membership, and the key result
  // must be in the opportunity's own workspace (a member of two workspaces must not cross-link them).
  const { workspaceId } = await requireProductEntity("opportunity", opportunityId);
  if (keyResultId) await requireProductEntity("keyResult", keyResultId, workspaceId);
  const session = await auth();
  const prisma = getPrisma();
  // Dual-write in ONE transaction: the legacy column and its LEGACY Opportunity<->Objective link.
  await captureWorkspaceMutation(
    prisma,
    "opportunity",
    "update",
    "UI",
    opportunityId,
    tx => setOpportunityKeyResult(tx, { opportunityId, keyResultId, expectedWorkspaceId: workspaceId, ctx: { source: "UI", createdById: session?.user?.id ?? null } }),
    { atomic: true },
  );
  revalidatePath(revalidatePathStr);
}

export async function archiveOpportunity(
  opportunityId: string,
  revalidatePathStr: string
) {
  await requireProductEntity("opportunity", opportunityId);
  const prisma = getPrisma();
  await captureWorkspaceMutation(prisma, "opportunity", "update", "UI", opportunityId, tx => tx.opportunity.update({
    where: { id: opportunityId },
    data: { status: "ARCHIVED" },
  }));
  revalidatePath(revalidatePathStr);
}

export async function archiveSolution(
  solutionId: string,
  revalidatePathStr: string
) {
  await requireProductEntity("solution", solutionId);
  const prisma = getPrisma();
  await captureWorkspaceMutation(prisma, "solution", "update", "UI", solutionId, tx => tx.solution.update({
    where: { id: solutionId },
    data: { status: "KILLED" },
  }));
  revalidatePath(revalidatePathStr);
}

export async function deleteAssumption(
  assumptionId: string,
  revalidatePathStr: string
) {
  const prisma = getPrisma();
  await prisma.assumption.delete({ where: { id: assumptionId } });
  revalidatePath(revalidatePathStr);
}

// ─── Move Opportunity (cross-column status change) ────────────────────────────

export async function moveOpportunity(
  opportunityId: string,
  status: OpportunityStatus,
  workspaceId: string,
  revalidatePathStr: string
) {
  await requireProductEntity("opportunity", opportunityId, workspaceId);
  const prisma = getPrisma();

  // Place moved item at end of destination column.
  const lastItem = await prisma.opportunity.findFirst({
    where: { workspaceId, status, NOT: { id: opportunityId } },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const sortOrder = lastItem ? lastItem.sortOrder + 1 : 0;

  await captureWorkspaceMutation(prisma, "opportunity", "update", "UI", opportunityId, tx => tx.opportunity.update({
    where: { id: opportunityId },
    data: { status, sortOrder },
  }));
  revalidatePath(revalidatePathStr);
}

// ─── Reorder Opportunity (same-column sort) ───────────────────────────────────

export async function reorderOpportunity(
  opportunityId: string,
  sortOrder: number,
  revalidatePathStr: string
) {
  await requireProductEntity("opportunity", opportunityId);
  const prisma = getPrisma();
  await captureWorkspaceMutation(prisma, "opportunity", "update", "UI", opportunityId, tx => tx.opportunity.update({
    where: { id: opportunityId },
    data: { sortOrder },
  }));
  revalidatePath(revalidatePathStr);
}

// ─── Set Opportunity field value (card-sort board move) ───────────────────────
// The "Group by <field>" board's cross-column drag. Only the CustomFieldValue
// row changes: status, sortOrder and archive state are deliberately untouched,
// so sorting cards into MoSCoW buckets never moves them through the funnel.
// `null` clears the value (the Unspecified column).

export async function setOpportunityFieldValue(
  opportunityId: string,
  fieldId: string,
  value: string | null,
  workspaceId: string,
  revalidatePathStr: string
): Promise<{ value: string | null }> {
  await requireProductEntity("opportunity", opportunityId, workspaceId);
  const prisma = getPrisma();

  // Scoped by workspace, so a field id from another tenant reads as missing.
  const row = await prisma.customFieldDefinition.findFirst({
    where: { id: fieldId, workspaceId },
    include: { sharedOptionSet: { select: { id: true, name: true, options: true } } },
  });
  if (!row) throw new Error("Field not found in this workspace");

  // Resolves shared option sets, so `options` is the field's effective list.
  const validationError = validateOpportunityFieldMove(toCustomFieldDefinitionData(row), value);
  if (validationError) throw new Error(validationError);

  if (value === null) {
    await prisma.customFieldValue.deleteMany({ where: { fieldId, objectId: opportunityId } });
  } else {
    await prisma.customFieldValue.upsert({
      where: { fieldId_objectId: { fieldId, objectId: opportunityId } },
      create: { fieldId, objectId: opportunityId, value },
      update: { value, updatedAt: new Date() },
    });
  }
  revalidatePath(revalidatePathStr);
  return { value };
}

// ─── Move Solution (cross-column status change within its own Opportunity) ────
// Mirrors moveOpportunity's find-last-then-append pattern, but scoped to
// { opportunityId, status } rather than just { status } — the "last item"
// lookup must be per-lane (this Opportunity's own column), not global across
// the workspace, since a swimlane board has one status column per
// Opportunity. Never touches opportunityId: reparenting a Solution to a
// different Opportunity is a deliberate action in its panel, not a side
// effect of a drag on this board.

export async function moveSolutionStatus(
  solutionId: string,
  status: SolutionStatus,
  opportunityId: string,
  workspaceId: string,
  revalidatePathStr: string
) {
  const authorized = await requireProductEntity("solution", solutionId, workspaceId);
  if (authorized.opportunityId !== opportunityId) throw new Error("Solution not found in opportunity");
  const prisma = getPrisma();

  const lastItem = await prisma.solution.findFirst({
    where: { opportunityId, status, NOT: { id: solutionId } },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const sortOrder = lastItem ? lastItem.sortOrder + 1 : 0;

  await captureWorkspaceMutation(prisma, "solution", "update", "UI", solutionId, tx => tx.solution.update({
    where: { id: solutionId },
    data: { status, sortOrder },
  }));
  revalidatePath(revalidatePathStr);
}

// ─── Reorder Solution ─────────────────────────────────────────────────────────

export async function reorderSolution(
  solutionId: string,
  sortOrder: number,
  revalidatePathStr: string
) {
  await requireProductEntity("solution", solutionId);
  const prisma = getPrisma();
  await captureWorkspaceMutation(prisma, "solution", "update", "UI", solutionId, tx => tx.solution.update({
    where: { id: solutionId },
    data: { sortOrder },
  }));
  revalidatePath(revalidatePathStr);
}

// ─── Reorder Assumption ───────────────────────────────────────────────────────

export async function reorderAssumption(
  assumptionId: string,
  sortOrder: number,
  revalidatePathStr: string
) {
  const prisma = getPrisma();
  await captureWorkspaceMutation(prisma, "assumption", "update", "UI", assumptionId, tx => tx.assumption.update({
    where: { id: assumptionId },
    data: { sortOrder },
  }));
  revalidatePath(revalidatePathStr);
}

// ─── Helper: resolve workspace and assert membership ─────────────────────────
// Mirrors resolveWorkspace in ../settings/actions.ts (kept local/private there,
// same shape here) — any workspace member may save an opportunity score, per
// the brainstorm decision (only *picking* the active model is admin-gated).

async function resolveWorkspace(orgSlug: string, workspaceSlug: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const prisma = getPrisma();
  const workspace = await prisma.workspace.findFirst({
    where: {
      slug: workspaceSlug,
      organization: { slug: orgSlug },
      members: { some: { userId: session.user.id } },
    },
    select: { id: true },
  });

  if (!workspace) throw new Error("Workspace not found");
  return { prisma, workspaceId: workspace.id, userId: session.user.id };
}

// ─── Opportunity Scoring ───────────────────────────────────────────────────────

/**
 * Computes and upserts an Opportunity's score against its workspace's active
 * scoring model. Validates raw values against each metric's bounds, snapshots
 * the formula definitions (so historical scores survive future template
 * edits), and stamps the model's current version — see
 * OpportunityScore.modelVersion in prisma/schema.prisma for the staleness
 * semantics this enables.
 */
export async function saveOpportunityScore(
  orgSlug: string,
  workspaceSlug: string,
  opportunityId: string,
  rawValues: Record<string, number>,
  revalidatePathStr: string
) {
  const { prisma, workspaceId, userId } = await resolveWorkspace(orgSlug, workspaceSlug);

  const opportunity = await prisma.opportunity.findFirst({
    where: { id: opportunityId, workspaceId },
    select: { id: true },
  });
  if (!opportunity) throw new Error("Opportunity not found");

  const scoringConfig = await prisma.workspaceScoringConfig.findUnique({
    where: { workspaceId },
    include: { opportunityScoringModel: { include: { metrics: { orderBy: { order: "asc" } } } } },
  });
  if (!scoringConfig?.opportunityScoringModel) {
    throw new Error("This workspace has no active scoring model");
  }

  const model = scoringConfig.opportunityScoringModel;
  const formulaType = model.formulaType as ScoringFormulaType;
  const metricDefs: ScoringMetricDef[] = model.metrics.map((m) => ({
    key: m.key,
    minValue: m.minValue,
    maxValue: m.maxValue,
    weight: m.weight,
    direction: m.direction as MetricDirection,
  }));

  validateMetricsForFormula(metricDefs, formulaType);

  for (const metric of metricDefs) {
    const value = rawValues[metric.key];
    if (typeof value !== "number" || Number.isNaN(value)) {
      throw new Error(`Missing value for metric "${metric.key}"`);
    }
    if (value < metric.minValue || value > metric.maxValue) {
      throw new Error(
        `Value for "${metric.key}" must be between ${metric.minValue} and ${metric.maxValue}`
      );
    }
  }

  const { rawScore, normalizedScore } = computeScore(metricDefs, rawValues, formulaType);

  const formulaSnapshot: FormulaSnapshotMetric[] = model.metrics.map((m) => ({
    key: m.key,
    label: m.label,
    minValue: m.minValue,
    maxValue: m.maxValue,
    weight: m.weight,
    direction: m.direction as MetricDirection,
  }));

  await prisma.opportunityScore.upsert({
    where: { opportunityId },
    create: {
      opportunityId,
      scoringModelId: model.id,
      modelVersion: model.version,
      formulaSnapshot: formulaSnapshot as unknown as Prisma.InputJsonValue,
      rawValues: rawValues as unknown as Prisma.InputJsonValue,
      rawScore,
      normalizedScore,
      scoredByUserId: userId,
    },
    update: {
      scoringModelId: model.id,
      modelVersion: model.version,
      formulaSnapshot: formulaSnapshot as unknown as Prisma.InputJsonValue,
      rawValues: rawValues as unknown as Prisma.InputJsonValue,
      rawScore,
      normalizedScore,
      scoredAt: new Date(),
      scoredByUserId: userId,
      updatedAt: new Date(),
    },
  });

  revalidatePath(revalidatePathStr);

  return { rawScore, normalizedScore };
}

// ─── Solution Scoring ──────────────────────────────────────────────────────────
// Structural mirror of saveOpportunityScore above, resolving the workspace's
// Solution scoring slot (opportunityScoringConfig.solutionScoringModel)
// instead of its Opportunity one — see WorkspaceScoringConfig in
// prisma/schema.prisma for why these are two independent columns.

export async function saveSolutionScore(
  orgSlug: string,
  workspaceSlug: string,
  solutionId: string,
  rawValues: Record<string, number>,
  revalidatePathStr: string
) {
  const { prisma, workspaceId, userId } = await resolveWorkspace(orgSlug, workspaceSlug);

  const solution = await prisma.solution.findFirst({
    where: { id: solutionId, workspaceId },
    select: { id: true },
  });
  if (!solution) throw new Error("Solution not found");

  const scoringConfig = await prisma.workspaceScoringConfig.findUnique({
    where: { workspaceId },
    include: { solutionScoringModel: { include: { metrics: { orderBy: { order: "asc" } } } } },
  });
  if (!scoringConfig?.solutionScoringModel) {
    throw new Error("This workspace has no active Solution scoring model");
  }

  const model = scoringConfig.solutionScoringModel;
  const formulaType = model.formulaType as ScoringFormulaType;
  const metricDefs: ScoringMetricDef[] = model.metrics.map((m) => ({
    key: m.key,
    minValue: m.minValue,
    maxValue: m.maxValue,
    weight: m.weight,
    direction: m.direction as MetricDirection,
  }));

  validateMetricsForFormula(metricDefs, formulaType);

  for (const metric of metricDefs) {
    const value = rawValues[metric.key];
    if (typeof value !== "number" || Number.isNaN(value)) {
      throw new Error(`Missing value for metric "${metric.key}"`);
    }
    if (value < metric.minValue || value > metric.maxValue) {
      throw new Error(
        `Value for "${metric.key}" must be between ${metric.minValue} and ${metric.maxValue}`
      );
    }
  }

  const { rawScore, normalizedScore } = computeScore(metricDefs, rawValues, formulaType);

  const formulaSnapshot: FormulaSnapshotMetric[] = model.metrics.map((m) => ({
    key: m.key,
    label: m.label,
    minValue: m.minValue,
    maxValue: m.maxValue,
    weight: m.weight,
    direction: m.direction as MetricDirection,
  }));

  await prisma.solutionScore.upsert({
    where: { solutionId },
    create: {
      solutionId,
      scoringModelId: model.id,
      modelVersion: model.version,
      formulaSnapshot: formulaSnapshot as unknown as Prisma.InputJsonValue,
      rawValues: rawValues as unknown as Prisma.InputJsonValue,
      rawScore,
      normalizedScore,
      scoredByUserId: userId,
    },
    update: {
      scoringModelId: model.id,
      modelVersion: model.version,
      formulaSnapshot: formulaSnapshot as unknown as Prisma.InputJsonValue,
      rawValues: rawValues as unknown as Prisma.InputJsonValue,
      rawScore,
      normalizedScore,
      scoredAt: new Date(),
      scoredByUserId: userId,
      updatedAt: new Date(),
    },
  });

  revalidatePath(revalidatePathStr);

  return { rawScore, normalizedScore };
}

// ─── Evidence ──────────────────────────────────────────────────────────────
// Evidence is polymorphic: it attaches to exactly one of opportunityId,
// solutionId, or assumptionId. Aurora DSQL has no CHECK constraints, so that
// invariant is enforced here in application code.

type EvidenceTarget = {
  opportunityId?: string | null;
  solutionId?: string | null;
  assumptionId?: string | null;
};

function assertExactlyOneTarget({
  opportunityId,
  solutionId,
  assumptionId,
}: EvidenceTarget) {
  const count = [opportunityId, solutionId, assumptionId].filter(Boolean).length;
  if (count !== 1) {
    throw new Error(
      `Exactly one of opportunityId, solutionId, or assumptionId must be provided (got ${count}).`
    );
  }
}

export async function addEvidence(
  data: {
    workspaceId: string;
    sourceType: EvidenceSourceType;
    excerpt: string;
    confidence?: EvidenceConfidence;
    sourceUrl?: string;
    opportunityId?: string;
    solutionId?: string;
    assumptionId?: string;
  },
  revalidatePathStr: string
) {
  assertExactlyOneTarget(data);
  const prisma = getPrisma();
  const evidence = await captureWorkspaceMutation(prisma, "evidence", "create", "UI", undefined, tx => tx.evidence.create({
    data: {
      workspaceId: data.workspaceId,
      sourceType: data.sourceType,
      excerpt: data.excerpt,
      confidence: data.confidence ?? "medium",
      sourceUrl: data.sourceUrl,
      opportunityId: data.opportunityId,
      solutionId: data.solutionId,
      assumptionId: data.assumptionId,
    },
  }));
  revalidatePath(revalidatePathStr);
  return evidence;
}

export async function deleteEvidence(
  evidenceId: string,
  revalidatePathStr: string
) {
  const prisma = getPrisma();
  await prisma.evidence.delete({ where: { id: evidenceId } });
  revalidatePath(revalidatePathStr);
}

export async function linkEvidence(
  evidenceId: string,
  target: EvidenceTarget,
  revalidatePathStr: string
) {
  assertExactlyOneTarget(target);
  const prisma = getPrisma();
  const evidence = await captureWorkspaceMutation(prisma, "evidence", "update", "UI", evidenceId, tx => tx.evidence.update({
    where: { id: evidenceId },
    data: {
      opportunityId: target.opportunityId ?? null,
      solutionId: target.solutionId ?? null,
      assumptionId: target.assumptionId ?? null,
    },
  }));
  revalidatePath(revalidatePathStr);
  return evidence;
}

// ─── Solution Comments (Plan & Discussion) ────────────────────────────────────
// UI-originated posts. authorName/authorType are derived from the
// authenticated session user (unlike the MCP tools, which require an explicit
// authorName since there's no resolved per-user identity over MCP).

export async function addSolutionComment(
  solutionId: string,
  data: { body: string; commentType?: CommentType },
  revalidatePathStr: string
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const prisma = getPrisma();
  const authorName = session.user.name ?? session.user.email ?? "Unknown";

  const comment = await prisma.solutionComment.create({
    data: {
      solutionId,
      commentType: data.commentType ?? "COMMENT",
      body: data.body.trim(),
      authorName,
      authorType: "HUMAN",
      source: "UI",
    },
  });
  try { await mirrorLegacySolutionComment(comment); } catch (error) { await prisma.solutionComment.delete({ where: { id: comment.id } }); throw error; }
  revalidatePath(revalidatePathStr);
  return comment;
}

export async function updateSolutionComment(
  commentId: string,
  body: string,
  revalidatePathStr: string
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const prisma = getPrisma();
  const comment = await prisma.solutionComment.update({
    where: { id: commentId },
    data: { body: body.trim(), updatedAt: new Date() },
  });
  await updateMirroredComment(commentId, comment.body);
  revalidatePath(revalidatePathStr);
  return comment;
}

export async function deleteSolutionComment(
  commentId: string,
  revalidatePathStr: string
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const prisma = getPrisma();
  await prisma.solutionComment.delete({ where: { id: commentId } });
  await deleteMirroredComment(commentId);
  revalidatePath(revalidatePathStr);
}

// Approving/rejecting only applies to PLAN entries — a COMMENT has nothing
// to approve. Purely a status marker: no side effects on Solution.status.
async function setSolutionPlanStatus(
  commentId: string,
  planStatus: PlanStatus,
  revalidatePathStr: string
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const prisma = getPrisma();
  const existing = await prisma.solutionComment.findUnique({
    where: { id: commentId },
    select: { id: true, commentType: true },
  });
  if (!existing) throw new Error("Comment not found");
  if (existing.commentType !== "PLAN") {
    throw new Error("Only PLAN entries can be approved or rejected");
  }

  const comment = await prisma.solutionComment.update({
    where: { id: commentId },
    data: { planStatus, updatedAt: new Date() },
  });
  await updateMirroredLegacyPlanStatus(commentId, planStatus);
  revalidatePath(revalidatePathStr);
  return comment;
}

export async function approveSolutionPlan(
  commentId: string,
  revalidatePathStr: string
) {
  return setSolutionPlanStatus(commentId, "APPROVED", revalidatePathStr);
}

export async function rejectSolutionPlan(
  commentId: string,
  revalidatePathStr: string
) {
  return setSolutionPlanStatus(commentId, "REJECTED", revalidatePathStr);
}
