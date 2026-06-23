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
  }
) {
  const prisma = await getPrisma()

  const experiment = await prisma.experiment.create({
    data: {
      workspaceId,
      title: data.title,
      hypothesis: data.hypothesis,
      method: data.method,
      killCondition: data.killCondition,
      assumptionId: data.assumptionId ?? null,
      status: "DESIGNING",
    },
  })

  revalidatePath(`/[orgSlug]/[workspaceSlug]/experiments`)
  return experiment
}

export async function startExperiment(experimentId: string) {
  const prisma = await getPrisma()

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
  const prisma = await getPrisma()

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
  const prisma = await getPrisma()

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
