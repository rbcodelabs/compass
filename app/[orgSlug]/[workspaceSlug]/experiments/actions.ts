"use server"

import { revalidatePath } from "next/cache"
import { getHumanActivityPrisma as getPrisma } from "@/lib/analytics/activity"
import type { ExperimentStatus, AssumptionStatus } from "@/lib/types"
import { requireProductEntity, requireProductWorkspace } from "@/lib/product-action-auth"

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
  await requireProductWorkspace(workspaceId)
  const prisma = getPrisma()

  if (data.assumptionId && !await prisma.assumption.findFirst({ where: { id: data.assumptionId, solution: { opportunity: { workspaceId } } }, select: { id: true } })) throw new Error("Assumption not found in workspace")
  if (data.squadId && !await prisma.squad.findFirst({ where: { id: data.squadId, workspaceId }, select: { id: true } })) throw new Error("Squad not found in workspace")

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
  await requireProductEntity("experiment", experimentId)
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
  await requireProductEntity("experiment", experimentId)
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
  conclusion: "PROCEED" | "KILL" | "ITERATE" | "NOT_PURSUED",
  reason?: string
) {
  const { workspaceId } = await requireProductEntity("experiment", experimentId)
  const prisma = getPrisma()

  const trimmedReason = reason?.trim() ?? ""
  if (conclusion === "NOT_PURSUED" && !trimmedReason) {
    throw new Error(
      "NOT_PURSUED requires a reason explaining why this experiment was deliberately not pursued."
    )
  }

  // NOT_PURSUED is a deliberate human decision not to run the experiment at
  // all — it must land on its own terminal status, distinct from KILLED
  // (an evidence-based failure) and COMPLETE (a finished, evidence-bearing
  // run), so an OST reader can never mistake "we chose not to test this"
  // for "we tested it and it failed."
  const newStatus: ExperimentStatus =
    conclusion === "KILL"
      ? "KILLED"
      : conclusion === "NOT_PURSUED"
        ? "NOT_PURSUED"
        : "COMPLETE"

  const experiment = await prisma.$transaction(async tx => {
  const current = await tx.experiment.findFirst({ where: { id: experimentId, workspaceId }, select: { assumptionId: true } })
  if (!current) throw new Error("Experiment not found")
  if (current.assumptionId && !await tx.assumption.findFirst({ where: { id: current.assumptionId, solution: { opportunity: { workspaceId } } }, select: { id: true } })) throw new Error("Assumption not found in workspace")
  const updated = await tx.experiment.update({
    where: { id: experimentId },
    data: {
      status: newStatus,
      conclusion,
      conclusionReason: trimmedReason || null,
      endDate: new Date(),
    },
  })

  // Update the linked assumption status if there is one
  if (updated.assumptionId) {
    // NOT_PURSUED, like ITERATE, leaves the assumption UNTESTED — the
    // experiment never ran, so the assumption was never disproven, only
    // left unexamined. Do not invent evidence by marking it INVALIDATED.
    const assumptionStatus: AssumptionStatus =
      conclusion === "PROCEED"
        ? "VALIDATED"
        : conclusion === "KILL"
          ? "INVALIDATED"
          : "UNTESTED"

    await tx.assumption.update({
      where: { id: updated.assumptionId },
      data: { status: assumptionStatus },
    })
  }
  return updated
  })

  revalidatePath(`/[orgSlug]/[workspaceSlug]/experiments`)
  return experiment
}

export async function archiveExperiment(
  experimentId: string,
  revalidatePathStr: string
) {
  await requireProductEntity("experiment", experimentId)
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
  await requireProductEntity("experiment", experimentId, workspaceId)
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
  await requireProductEntity("experiment", experimentId)
  const prisma = getPrisma()
  await prisma.experiment.update({
    where: { id: experimentId },
    data: { sortOrder },
  })
  revalidatePath(revalidatePathStr)
}
