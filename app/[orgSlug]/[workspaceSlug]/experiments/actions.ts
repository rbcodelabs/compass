"use server"

import { revalidatePath } from "next/cache"
import getPrisma from "@/lib/db"
import type { ExperimentStatus, AssumptionStatus } from "@/lib/types"

export async function createExperiment(
  workspaceId: string,
  data: {
    title: string
    hypothesis: string
    method: string
    killCondition: string
    assumptionId?: string
    squadId?: string | null
  }
) {
  const prisma = getPrisma()

  const experiment = await prisma.experiment.create({
    data: {
      workspaceId,
      title: data.title,
      hypothesis: data.hypothesis,
      method: data.method,
      killCondition: data.killCondition,
      assumptionId: data.assumptionId ?? null,
      squadId: data.squadId ?? null,
      status: "DESIGNING",
    },
  })

  revalidatePath(`/[orgSlug]/[workspaceSlug]/experiments`)
  return experiment
}

export async function startExperiment(experimentId: string) {
  const prisma = getPrisma()

  const experiment = await prisma.experiment.update({
    where: { id: experimentId },
    data: {
      status: "RUNNING",
      startDate: new Date(),
    },
  })

  revalidatePath(`/[orgSlug]/[workspaceSlug]/experiments`)
  return experiment
}

export async function logResult(
  experimentId: string,
  data: {
    note: string
    metric?: string
    value?: number
  }
) {
  const prisma = getPrisma()

  const result = await prisma.experimentResult.create({
    data: {
      experimentId,
      note: data.note,
      metric: data.metric ?? null,
      value: data.value ?? null,
    },
  })

  revalidatePath(`/[orgSlug]/[workspaceSlug]/experiments`)
  return result
}

export async function concludeExperiment(
  experimentId: string,
  conclusion: "PROCEED" | "KILL" | "ITERATE"
) {
  const prisma = getPrisma()

  const newStatus: ExperimentStatus =
    conclusion === "KILL" ? "KILLED" : "COMPLETE"

  const experiment = await prisma.experiment.update({
    where: { id: experimentId },
    data: {
      status: newStatus,
      conclusion,
      endDate: new Date(),
    },
  })

  // Update the linked assumption status if there is one
  if (experiment.assumptionId) {
    const assumptionStatus: AssumptionStatus =
      conclusion === "PROCEED"
        ? "VALIDATED"
        : conclusion === "KILL"
          ? "INVALIDATED"
          : "UNTESTED"

    await prisma.assumption.update({
      where: { id: experiment.assumptionId },
      data: { status: assumptionStatus },
    })
  }

  revalidatePath(`/[orgSlug]/[workspaceSlug]/experiments`)
  return experiment
}

export async function archiveExperiment(
  experimentId: string,
  revalidatePathStr: string
) {
  const prisma = getPrisma()
  await prisma.experiment.update({
    where: { id: experimentId },
    data: { status: "KILLED" },
  })
  revalidatePath(revalidatePathStr)
}

// ─── Move Experiment (cross-column status change) ─────────────────────────────

export async function moveExperiment(
  experimentId: string,
  status: ExperimentStatus,
  workspaceId: string,
  revalidatePathStr: string
) {
  const prisma = getPrisma()

  const lastItem = await prisma.experiment.findFirst({
    where: { workspaceId, status, NOT: { id: experimentId } },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  })
  const sortOrder = lastItem ? lastItem.sortOrder + 1 : 0

  await prisma.experiment.update({
    where: { id: experimentId },
    data: { status, sortOrder },
  })
  revalidatePath(revalidatePathStr)
}

// ─── Reorder Experiment (same-column sort) ────────────────────────────────────

export async function reorderExperiment(
  experimentId: string,
  sortOrder: number,
  revalidatePathStr: string
) {
  const prisma = getPrisma()
  await prisma.experiment.update({
    where: { id: experimentId },
    data: { sortOrder },
  })
  revalidatePath(revalidatePathStr)
}
