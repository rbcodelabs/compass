"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { Prisma } from "@prisma/client";
import { computeScore, validateMetricsForFormula, type ScoringMetricDef } from "@/lib/scoring";
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
} from "@/lib/types";

// Types live in @/lib/types — import from there directly.

export async function createOpportunity(
  workspaceId: string,
  data: {
    title: string;
    description?: string;
    customerSegment?: string;
    status?: OpportunityStatus;
    squadId?: string | null;
  }
) {
  const prisma = getPrisma();
  const opportunity = await prisma.opportunity.create({
    data: {
      workspaceId,
      title: data.title,
      description: data.description,
      customerSegment: data.customerSegment,
      status: data.status ?? "EXPLORING",
      squadId: data.squadId ?? null,
    },
  });
  revalidatePath(`/[orgSlug]/[workspaceSlug]/discovery`, "page");
  return opportunity;
}

export async function updateOpportunityStatus(
  opportunityId: string,
  status: OpportunityStatus,
  revalidatePathStr: string
) {
  const prisma = getPrisma();
  const opportunity = await prisma.opportunity.update({
    where: { id: opportunityId },
    data: { status },
  });
  revalidatePath(revalidatePathStr);
  return opportunity;
}

export async function addSolution(
  opportunityId: string,
  data: { title: string; description?: string },
  revalidatePathStr: string
) {
  const prisma = getPrisma();
  const solution = await prisma.solution.create({
    data: {
      opportunityId,
      title: data.title,
      description: data.description,
    },
  });
  revalidatePath(revalidatePathStr);
  return solution;
}

export async function updateSolutionStatus(
  solutionId: string,
  status: SolutionStatus,
  revalidatePathStr: string
) {
  const prisma = getPrisma();
  const solution = await prisma.solution.update({
    where: { id: solutionId },
    data: { status },
  });
  revalidatePath(revalidatePathStr);
  return solution;
}

export async function addAssumption(
  solutionId: string,
  data: { title: string; riskLevel: RiskLevel },
  revalidatePathStr: string
) {
  const prisma = getPrisma();
  const assumption = await prisma.assumption.create({
    data: {
      solutionId,
      title: data.title,
      riskLevel: data.riskLevel,
    },
  });
  revalidatePath(revalidatePathStr);
  return assumption;
}

export async function updateAssumptionStatus(
  assumptionId: string,
  status: AssumptionStatus,
  revalidatePathStr: string
) {
  const prisma = getPrisma();
  const assumption = await prisma.assumption.update({
    where: { id: assumptionId },
    data: { status },
  });
  revalidatePath(revalidatePathStr);
  return assumption;
}

export async function linkOpportunityToKeyResult(
  opportunityId: string,
  keyResultId: string | null,
  revalidatePathStr: string
) {
  const prisma = getPrisma();
  await prisma.opportunity.update({
    where: { id: opportunityId },
    data: { linkedKeyResultId: keyResultId },
  });
  revalidatePath(revalidatePathStr);
}

export async function archiveOpportunity(
  opportunityId: string,
  revalidatePathStr: string
) {
  const prisma = getPrisma();
  await prisma.opportunity.update({
    where: { id: opportunityId },
    data: { status: "ARCHIVED" },
  });
  revalidatePath(revalidatePathStr);
}

export async function archiveSolution(
  solutionId: string,
  revalidatePathStr: string
) {
  const prisma = getPrisma();
  await prisma.solution.update({
    where: { id: solutionId },
    data: { status: "KILLED" },
  });
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
  const prisma = getPrisma();

  // Place moved item at end of destination column.
  const lastItem = await prisma.opportunity.findFirst({
    where: { workspaceId, status, NOT: { id: opportunityId } },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const sortOrder = lastItem ? lastItem.sortOrder + 1 : 0;

  await prisma.opportunity.update({
    where: { id: opportunityId },
    data: { status, sortOrder },
  });
  revalidatePath(revalidatePathStr);
}

// ─── Reorder Opportunity (same-column sort) ───────────────────────────────────

export async function reorderOpportunity(
  opportunityId: string,
  sortOrder: number,
  revalidatePathStr: string
) {
  const prisma = getPrisma();
  await prisma.opportunity.update({
    where: { id: opportunityId },
    data: { sortOrder },
  });
  revalidatePath(revalidatePathStr);
}

// ─── Reorder Solution ─────────────────────────────────────────────────────────

export async function reorderSolution(
  solutionId: string,
  sortOrder: number,
  revalidatePathStr: string
) {
  const prisma = getPrisma();
  await prisma.solution.update({
    where: { id: solutionId },
    data: { sortOrder },
  });
  revalidatePath(revalidatePathStr);
}

// ─── Reorder Assumption ───────────────────────────────────────────────────────

export async function reorderAssumption(
  assumptionId: string,
  sortOrder: number,
  revalidatePathStr: string
) {
  const prisma = getPrisma();
  await prisma.assumption.update({
    where: { id: assumptionId },
    data: { sortOrder },
  });
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
    include: { scoringModel: { include: { metrics: { orderBy: { order: "asc" } } } } },
  });
  if (!scoringConfig?.scoringModel) {
    throw new Error("This workspace has no active scoring model");
  }

  const model = scoringConfig.scoringModel;
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
  const evidence = await prisma.evidence.create({
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
  });
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
  const evidence = await prisma.evidence.update({
    where: { id: evidenceId },
    data: {
      opportunityId: target.opportunityId ?? null,
      solutionId: target.solutionId ?? null,
      assumptionId: target.assumptionId ?? null,
    },
  });
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
  revalidatePath(revalidatePathStr);
}
