"use server"

import { captureWorkspaceMutation } from "@/lib/workspace-update-mutations"
import { workspaceUpdatesAvailable, recordWorkspaceUpdate, retryUpdatesTransaction } from "@/lib/workspace-updates-capture"
import { workspaceMutationActor } from "@/lib/workspace-update-mutations"
import { revalidatePath } from "next/cache"
import { getHumanActivityPrisma as getPrisma } from "@/lib/analytics/activity"
import type { ExperimentStatus, AssumptionStatus } from "@/lib/types"
import { requireProductEntity, requireProductWorkspace, requireProductWorkspaceBySlug } from "@/lib/product-action-auth"
import type { AssumptionOptionData, SquadData } from "@/lib/types"
import { EXPERIMENT_TITLE_MAX_LENGTH } from "@/lib/experiment-draft"

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
  await requireProductEntity("experiment", experimentId)
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
  await requireProductEntity("experiment", experimentId)
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

  const capture = await workspaceUpdatesAvailable(prisma)
  const actor = capture ? await workspaceMutationActor("UI") : null
  const experiment = await retryUpdatesTransaction(prisma, async tx => {
  const current = await tx.experiment.findFirst({ where: { id: experimentId, workspaceId }, select: { assumptionId: true, status: true } })
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
  if (capture && actor) await recordWorkspaceUpdate(tx, {workspaceId,entityType:"EXPERIMENT",entityId:experimentId,kind:"STATUS_CHANGED",before:current.status,after:updated.status,...actor})

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

    const beforeAssumption = capture ? await tx.assumption.findUnique({where:{id:updated.assumptionId},select:{status:true}}) : null
    await tx.assumption.update({
      where: { id: updated.assumptionId },
      data: { status: assumptionStatus },
    })
    if(capture && actor) await recordWorkspaceUpdate(tx,{workspaceId,entityType:"ASSUMPTION",entityId:updated.assumptionId,kind:"STATUS_CHANGED",before:beforeAssumption?.status,after:assumptionStatus,...actor})
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
  await requireProductEntity("experiment", experimentId, workspaceId)
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
  await requireProductEntity("experiment", experimentId)
  const prisma = getPrisma()
  await captureWorkspaceMutation(prisma, "experiment", "update", "UI", experimentId, tx => tx.experiment.update({
    where: { id: experimentId },
    data: { sortOrder },
  }))
  revalidatePath(revalidatePathStr)
}

export type ExperimentComposerOptions = {
  squads: SquadData[]
  assumptions: AssumptionOptionData[]
}

/** What the "New experiment" composer's pickers choose from. */
export async function loadExperimentComposerOptions(
  orgSlug: string,
  workspaceSlug: string
): Promise<{ ok: true; options: ExperimentComposerOptions } | { ok: false; error: string }> {
  let workspaceId: string
  try {
    workspaceId = await requireProductWorkspaceBySlug(orgSlug, workspaceSlug)
  } catch {
    return { ok: false, error: "Workspace not found or you no longer have access to it." }
  }
  const prisma = getPrisma()
  const [squads, assumptions] = await Promise.all([
    prisma.squad.findMany({ where: { workspaceId }, select: { id: true, name: true, color: true }, orderBy: { createdAt: "asc" } }),
    prisma.assumption.findMany({
      where: { solution: { opportunity: { workspaceId } } },
      orderBy: { createdAt: "desc" },
      select: { id: true, title: true, solution: { select: { title: true, opportunity: { select: { title: true } } } } },
    }),
  ])
  return {
    ok: true,
    options: {
      squads,
      assumptions: assumptions.map((a) => ({
        id: a.id,
        title: a.title,
        solutionTitle: a.solution.title,
        opportunityTitle: a.solution.opportunity.title,
      })),
    },
  }
}

export type CreateExperimentFromComposerResult =
  | { ok: true; experiment: { id: string; title: string } }
  | { ok: false; error: string }

/** Composer entry point: resolves the workspace by slug and reports failures as values. */
export async function createExperimentFromComposer(
  orgSlug: string,
  workspaceSlug: string,
  data: {
    title: string
    hypothesis: string
    method: string
    killCondition: string
    assumptionId?: string | null
    squadId?: string | null
  }
): Promise<CreateExperimentFromComposerResult> {
  let workspaceId: string
  try {
    workspaceId = await requireProductWorkspaceBySlug(orgSlug, workspaceSlug)
  } catch {
    return { ok: false, error: "Workspace not found or you no longer have access to it." }
  }
  const title = data.title.trim()
  const hypothesis = data.hypothesis.trim()
  const method = data.method.trim()
  const killCondition = data.killCondition.trim()
  if (!title || !hypothesis || !method || !killCondition) {
    return { ok: false, error: "Title, hypothesis, method and kill condition are all required." }
  }
  if (title.length > EXPERIMENT_TITLE_MAX_LENGTH) {
    return { ok: false, error: `Title must be ${EXPERIMENT_TITLE_MAX_LENGTH} characters or fewer.` }
  }
  try {
    const experiment = await createExperiment(workspaceId, {
      title,
      hypothesis,
      method,
      killCondition,
      assumptionId: data.assumptionId ?? undefined,
      squadId: data.squadId ?? null,
    })
    return { ok: true, experiment: { id: experiment.id, title: experiment.title } }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to create experiment" }
  }
}
