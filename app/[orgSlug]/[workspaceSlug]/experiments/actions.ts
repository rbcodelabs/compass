"use server"

import { captureWorkspaceMutation } from "@/lib/workspace-update-mutations"
import { workspaceUpdatesAvailable, recordWorkspaceUpdate, retryUpdatesTransaction } from "@/lib/workspace-updates-capture"
import { workspaceMutationActor } from "@/lib/workspace-update-mutations"
import { revalidatePath } from "next/cache"
import { getHumanActivityPrisma as getPrisma } from "@/lib/analytics/activity"
import type { ExperimentStatus, AssumptionStatus, AssumptionOptionData, SquadData } from "@/lib/types"
import { requireProductEntity, requireProductWorkspace, requireProductWorkspaceBySlug } from "@/lib/product-action-auth"
import { auth } from "@/auth"
import { getWorkspace } from "@/lib/workspace"
import * as analytics from "@/lib/analytics/service"
import type { McpActor } from "@/lib/mcp-authz"
import { assertWorkspaceWritable } from "@/lib/workspace-context"
import { allocateOneSeq } from "@/lib/work-item-sequence"

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

  if (data.assumptionId && !await prisma.assumption.findFirst({ where: { id: data.assumptionId, solution: { workspaceId } }, select: { id: true } })) throw new Error("Assumption not found in workspace")
  if (data.squadId && !await prisma.squad.findFirst({ where: { id: data.squadId, workspaceId }, select: { id: true } })) throw new Error("Squad not found in workspace")

  const experiment = await captureWorkspaceMutation(prisma, "experiment", "create", "UI", undefined, async tx => tx.experiment.create({
    data: {
      workspaceId,
      ...(await allocateOneSeq(tx, workspaceId, "experiment")),
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

/** A workspace metric the composer can link, in the fields its picker shows. */
export type ComposerMetricOption = { id: string; name: string; unit: string; provider: string }

export type ExperimentComposerOptions = {
  squads: SquadData[]
  assumptions: AssumptionOptionData[]
  metrics: ComposerMetricOption[]
}

/** The analytics service's actor for the signed-in member of this workspace. */
async function analyticsContext(orgSlug: string, workspaceSlug: string) {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Unauthorized")
  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id)
  if (!workspace) throw new Error("Workspace not found")
  const actor: McpActor = { userId: session.user.id, purpose: "USER", scopeWorkspaceId: workspace.id }
  return { actor, workspaceId: workspace.id, isReadOnly: workspace.isReadOnly }
}

/**
 * What the "New experiment" composer's pickers choose from: the workspace's
 * squads and the assumptions an experiment can test (each with the
 * opportunity and solution it hangs under, for context in the list).
 */
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
    prisma.squad.findMany({
      where: { workspaceId },
      select: { id: true, name: true, color: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.assumption.findMany({
      where: { solution: { workspaceId } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        solution: { select: { title: true, opportunity: { select: { title: true } } } },
      },
    }),
  ])
  // Metrics are optional context: if analytics can't be read, the rest of the
  // composer still works, so an error here just means an empty picker.
  let metrics: ComposerMetricOption[] = []
  try {
    const { actor } = await analyticsContext(orgSlug, workspaceSlug)
    metrics = (await analytics.listMetrics(actor, workspaceId))
      .filter((metric) => !metric.archived)
      .map((metric) => ({ id: metric.id, name: metric.name, unit: metric.unit, provider: metric.provider }))
  } catch {
    metrics = []
  }
  return {
    ok: true,
    options: {
      metrics,
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
  | {
      ok: true
      experiment: { id: string; title: string }
      /** Names of chosen metrics that could not be linked; the experiment itself was created. */
      unlinkedMetrics: string[]
    }
  | { ok: false; error: string }

/**
 * The "New experiment" composer's submit. Addressed by slug (the panel only
 * knows the URL) with membership resolved server-side, and it reports
 * failures as values so the composer can show them inline and keep the draft.
 */
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
    /** Workspace metrics to track on the new experiment (rolling 30 days, no baseline). */
    metricIds?: string[]
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
  if (!title) return { ok: false, error: "Add a title so your team can scan this at a glance." }
  if (title.length > 255) return { ok: false, error: "The title must be 255 characters or fewer." }
  if (!hypothesis) return { ok: false, error: "Add a hypothesis: what do you believe is true?" }
  if (!method) return { ok: false, error: "Add a method: how will you test it?" }
  if (!killCondition) return { ok: false, error: "Add a kill condition: when will you stop?" }

  try {
    const experiment = await createExperiment(workspaceId, {
      title,
      hypothesis,
      method,
      killCondition,
      assumptionId: data.assumptionId ?? undefined,
      squadId: data.squadId ?? null,
    })
    const unlinkedMetrics = await linkComposerMetrics(orgSlug, workspaceSlug, workspaceId, experiment.id, data.metricIds ?? [])
    return { ok: true, experiment: { id: experiment.id, title: experiment.title }, unlinkedMetrics }
  } catch (error) {
    // createExperiment's own checks (assumption / squad not in this workspace)
    // are safe to show; anything else is not worth leaking.
    const message = error instanceof Error ? error.message : ""
    if (message === "Assumption not found in workspace") {
      return { ok: false, error: "That assumption no longer exists. Pick another or clear it." }
    }
    if (message === "Squad not found in workspace") {
      return { ok: false, error: "That squad no longer exists. Pick another or clear it." }
    }
    throw error
  }
}

/**
 * Links the chosen metrics to the experiment that was just created, as
 * "track over time" (the Link metric dialog's default; comparison periods are
 * added later from the experiment). A metric that can't be linked must not
 * undo the experiment, so failures are collected by name instead of thrown.
 */
async function linkComposerMetrics(
  orgSlug: string,
  workspaceSlug: string,
  workspaceId: string,
  experimentId: string,
  metricIds: string[]
): Promise<string[]> {
  const unique = [...new Set(metricIds)]
  if (unique.length === 0) return []
  let context: Awaited<ReturnType<typeof analyticsContext>>
  let names = new Map<string, string>()
  try {
    context = await analyticsContext(orgSlug, workspaceSlug)
    assertWorkspaceWritable(context)
    names = new Map((await analytics.listMetrics(context.actor, workspaceId)).map((metric) => [metric.id, metric.name]))
  } catch {
    return unique.map((id) => names.get(id) ?? "A metric")
  }
  const failed: string[] = []
  for (const metricId of unique) {
    try {
      await analytics.linkMetric(context.actor, workspaceId, {
        targetType: "EXPERIMENT",
        targetId: experimentId,
        metricId,
        baseline: null,
        followup: { version: 1, mode: "rolling", days: 30 },
      })
    } catch {
      failed.push(names.get(metricId) ?? "A metric")
    }
  }
  return failed
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
  if (current.assumptionId && !await tx.assumption.findFirst({ where: { id: current.assumptionId, solution: { workspaceId } }, select: { id: true } })) throw new Error("Assumption not found in workspace")
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
