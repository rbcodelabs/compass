"use server";

import { revalidatePath } from "next/cache";
import getPrisma from "@/lib/db";
import type {
  OpportunityStatus,
  SolutionStatus,
  AssumptionStatus,
  RiskLevel,
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
