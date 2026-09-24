"use server"

import { captureWorkspaceMutation } from "@/lib/workspace-update-mutations"
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

  const experiment = await captureWorkspaceMutation(prisma, "experiment", "create", "UI", undefined, tx => tx.experiment.create({
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
  }))

  revalidatePath(`/[orgSlug]/[workspaceSlug]/experiments`)
  return experiment
}

export async function startExperiment(experimentId: string) {
  const prisma = getPrisma()

  const experiment = await captureWorkspaceMutation(prisma, "experiment", "update", "UI", experimentId, tx => tx.experiment.update({
    where: { id: experimentId },
    data: {
      status: "RUNNING",
      startDate: new Date(),
    },
  }))

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

  const result = await captureWorkspaceMutation(prisma, "experimentResult", "create", "UI", undefined, tx => tx.experimentResult.create({
    data: {
      experimentId,
      note: data.note,
      metric: data.metric ?? null,
      value: data.value ?? null,
    },
  }))

  revalidatePath(`/[orgSlug]/[workspaceSlug]/experiments`)
  return result
}

export async function concludeExperiment(
  experimentId: string,
  conclusion: "PROCEED" | "KILL" | "ITERATE" | "NOT_PURSUED",
  reason?: string
) {
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

  const experiment = await captureWorkspaceMutation(prisma, "experiment", "update", "UI", experimentId, tx => tx.experiment.update({
    where: { id: experimentId },
    data: {
      status: newStatus,
      conclusion,
      conclusionReason: trimmedReason || null,
      endDate: new Date(),
    },
  }))

  // Update the linked assumption status if there is one
  if (experiment.assumptionId) {
    // NOT_PURSUED, like ITERATE, leaves the assumption UNTESTED — the
    // experiment never ran, so the assumption was never disproven, only
    // left unexamined. Do not invent evidence by marking it INVALIDATED.
    const assumptionStatus: AssumptionStatus =
      conclusion === "PROCEED"
        ? "VALIDATED"
        : conclusion === "KILL"
          ? "INVALIDATED"
          : "UNTESTED"

    await captureWorkspaceMutation(prisma, "assumption", "update", "UI", experiment.assumptionId, tx => tx.assumption.update({
      where: { id: experiment.assumptionId! },
      data: { status: assumptionStatus },
    }))
  }

  revalidatePath(`/[orgSlug]/[workspaceSlug]/experiments`)
  return experiment
}

export async function archiveExperiment(
  experimentId: string,
  revalidatePathStr: string
) {
  const prisma = getPrisma()
  await captureWorkspaceMutation(prisma, "experiment", "update", "UI", experimentId, tx => tx.experiment.update({
    where: { id: experimentId },
    data: { status: "KILLED" },
  }))
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

  await captureWorkspaceMutation(prisma, "experiment", "update", "UI", experimentId, tx => tx.experiment.update({
    where: { id: experimentId },
    data: { status, sortOrder },
  }))
  revalidatePath(revalidatePathStr)
}

// ─── Reorder Experiment (same-column sort) ────────────────────────────────────

export async function reorderExperiment(
  experimentId: string,
  sortOrder: number,
  revalidatePathStr: string
) {
  const prisma = getPrisma()
  await captureWorkspaceMutation(prisma, "experiment", "update", "UI", experimentId, tx => tx.experiment.update({
    where: { id: experimentId },
    data: { sortOrder },
  }))
  revalidatePath(revalidatePathStr)
}
