"use server";

import { revalidatePath } from "next/cache";
import getPrisma from "@/lib/db";
import type {
  OpportunityStatus,
  SolutionStatus,
  AssumptionStatus,
  RiskLevel,
  EvidenceSourceType,
  EvidenceConfidence,
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
