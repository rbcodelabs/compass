/**
 * Handler functions for the Launch Tiers + Checklist Templates MCP tools.
 * Extracted into this module so they can be unit-tested without the MCP server layer,
 * following the same shape as lib/scoring-tool-handlers.ts.
 *
 * No extra role/membership gate beyond validateMcpAuth (API-key auth only) — matches
 * every other existing MCP tool.
 */

import { getMcpActivityPrisma as getPrisma } from "@/lib/analytics/activity"
import type { LaunchTier } from "@/lib/types"
import { setLaunchTierCore, updateChecklistItemCore } from "@/lib/launch-checklist"
import { ok, fail } from "@/lib/mcp-output"
import { captureWorkspaceMutation } from "@/lib/workspace-update-mutations"
import { withWorkspaceUpdates } from "@/lib/workspace-updates-capture"
import { LAUNCH_WORKFLOW_DISABLED_MESSAGE } from "@/lib/launch-checklist"
import { workspaceMutationSource, type ProgrammaticSource } from "@/lib/programmatic-source"
import { safeEntityUrl, withUrlLine } from "@/lib/compass-url"
import { randomUUID } from "node:crypto"
import { RoadmapPromotionConflict } from "@/lib/roadmap-promotion"
import { getMcpActor } from "@/lib/mcp-authz"
import { createRoadmapItemsFromSolutions } from "@/lib/roadmap/create-from-solution"
import { addCalendarDays } from "@/lib/roadmap-timeline/calendar-geometry"
import { durationDaysFor } from "@/lib/roadmap/scheduling"

export function roadmapCreateData(input: Parameters<typeof createRoadmapItem>[0], sortOrder: number) {
  return {
    workspaceId: input.workspaceId, title: input.title.trim(), horizon: input.horizon, description: input.description?.trim() || null,
    sortOrder, solutionId: input.solutionId ?? null, keyResultId: input.keyResultId ?? null, opportunityId: input.opportunityId ?? null,
    squadId: input.squadId ?? null, startDate: input.startDate ? new Date(input.startDate) : undefined,
    endDate: input.endDate ? new Date(input.endDate) : undefined, isPrivate: input.isPrivate ?? false, source: input.source ?? "MCP",
  }
}

export async function createRoadmapItem(input: {
  workspaceId: string; title: string; horizon: "NOW" | "NEXT" | "LATER" | "SHIPPED"; description?: string | null
  solutionId?: string | null; keyResultId?: string | null; opportunityId?: string | null; squadId?: string | null
  startDate?: string | null; endDate?: string | null; isPrivate?: boolean; source?: ProgrammaticSource
}) {
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findUnique({ where: { id: input.workspaceId }, select: { name: true, slug: true, organization: { select: { slug: true } } } })
  if (!workspace) return fail(`Workspace "${input.workspaceId}" not found.`)
  if (input.solutionId) return createFromSolution(prisma, workspace, input as typeof input & { solutionId: string })
  const lastItem = await prisma.roadmapItem.findFirst({ where: { workspaceId: input.workspaceId, horizon: input.horizon, status: "ACTIVE" }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } })
  const item = await captureWorkspaceMutation(prisma, "roadmapItem", "create", workspaceMutationSource(input.source), undefined, tx => tx.roadmapItem.create({ data: roadmapCreateData(input, lastItem ? lastItem.sortOrder + 1 : 0) }))
  const format = (date: Date) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).format(date)
  return ok(withUrlLine(
    `**Roadmap item created** (${input.horizon})\nID: ${item.id}\nTitle: ${item.title}` +
      (item.isPrivate ? "\nPrivate: yes (hidden from public portal)" : "") +
      (item.startDate || item.endDate ? `\nDates: ${item.startDate ? format(item.startDate) : "?"} – ${item.endDate ? format(item.endDate) : "?"}` : ""),
    safeEntityUrl({ orgSlug: workspace.organization?.slug, workspaceSlug: workspace.slug, type: "roadmapItem", id: item.id }),
  ), { id: item.id, title: item.title, horizon: item.horizon, isPrivate: item.isPrivate, solutionId: item.solutionId, keyResultId: item.keyResultId, opportunityId: item.opportunityId, squadId: item.squadId, startDate: item.startDate, endDate: item.endDate })
}

function actingUserId(): string | null {
  try { return getMcpActor().userId ?? null } catch { return null }
}

const calendarDay = (value: string) => new Date(value).toISOString().slice(0, 10)

/**
 * add_to_roadmap with a solutionId goes through the same shared creator as the UI and promote_to_roadmap, so
 * it is idempotent (a solution already on the roadmap returns that item) and fills the same defaults
 * (squad / key result inherited from the solution, a suggested slot when no dates are given).
 */
async function createFromSolution(
  prisma: ReturnType<typeof getPrisma>,
  workspace: { name: string; slug: string; organization: { slug: string } | null },
  input: Parameters<typeof createRoadmapItem>[0] & { solutionId: string },
) {
  let startDate = input.startDate ? calendarDay(input.startDate) : undefined
  const endDate = input.endDate ? calendarDay(input.endDate) : undefined
  // An end date alone is a deadline: back the start off by the default duration.
  if (!startDate && endDate) startDate = addCalendarDays(endDate, -(durationDaysFor(null) - 1))
  const result = await createRoadmapItemsFromSolutions(
    prisma,
    { workspaceId: input.workspaceId, source: input.source ?? "MCP", captureSource: workspaceMutationSource(input.source), userId: actingUserId() },
    [{
      solutionId: input.solutionId,
      horizon: input.horizon,
      title: input.title.trim(),
      description: input.description?.trim() || null,
      squadId: input.squadId ?? undefined,
      keyResultId: input.keyResultId ?? undefined,
      opportunityId: input.opportunityId ?? undefined,
      startDate,
      endDate: startDate ? endDate : undefined,
      isPrivate: input.isPrivate,
    }],
  )
  if (result.missing.length > 0) return fail(`Solution "${input.solutionId}" not found.`)
  const itemId = result.created[0]?.id ?? result.existing[0]?.itemId
  const item = itemId ? await prisma.roadmapItem.findUnique({ where: { id: itemId } }) : null
  if (!item) return fail("Roadmap item could not be created.")
  const created = result.created.length > 0
  const format = (date: Date) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).format(date)
  return ok(withUrlLine(
    `**${created ? "Roadmap item created" : "Solution is already on the roadmap"}** (${item.horizon})\nID: ${item.id}\nTitle: ${item.title}` +
      (item.isPrivate ? "\nPrivate: yes (hidden from public portal)" : "") +
      (item.startDate || item.endDate ? `\nDates: ${item.startDate ? format(item.startDate) : "?"} – ${item.endDate ? format(item.endDate) : "?"}` : ""),
    safeEntityUrl({ orgSlug: workspace.organization?.slug, workspaceSlug: workspace.slug, type: "roadmapItem", id: item.id }),
  ), { id: item.id, title: item.title, horizon: item.horizon, isPrivate: item.isPrivate, solutionId: item.solutionId, keyResultId: item.keyResultId, opportunityId: item.opportunityId, squadId: item.squadId, startDate: item.startDate, endDate: item.endDate, created })
}

export async function promoteSolutionToRoadmap(input: {
  workspaceId: string
  solutionId: string
  horizon: "NOW" | "NEXT" | "LATER" | "SHIPPED"
  isPrivate?: boolean
  source?: ProgrammaticSource
  operationId?: string
}) {
  const prisma = getPrisma()
  const solution = await prisma.solution.findFirst({
    where: { id: input.solutionId, workspaceId: input.workspaceId },
    select: { id: true, title: true, opportunity: { select: { id: true, title: true, squadId: true } } },
  })
  if (!solution) return fail("Solution not found.")
  const promotionId = input.operationId ?? randomUUID()
  const sameOperation = (item: { workspaceId: string; solutionId: string | null; opportunityId: string | null; squadId: string | null; horizon: string; isPrivate: boolean; source: string }) =>
    item.workspaceId === input.workspaceId && item.solutionId === input.solutionId && item.opportunityId === solution.opportunity.id &&
    item.squadId === solution.opportunity.squadId && item.horizon === input.horizon && item.isPrivate === (input.isPrivate ?? false) && item.source === (input.source ?? "MCP")

  // A retried operation converges on the item it already created; a reused id for a different promotion is rejected.
  if (input.operationId) {
    const prior = await prisma.roadmapItem.findUnique({ where: { id: promotionId } })
    if (prior) {
      if (!sameOperation(prior)) throw new RoadmapPromotionConflict("The operationId was already used for a different roadmap promotion.")
      return ok("Solution promoted to roadmap.", promotionData(prior, solution.opportunity.title, false))
    }
  }

  const result = await createRoadmapItemsFromSolutions(
    prisma,
    { workspaceId: input.workspaceId, source: input.source ?? "MCP", captureSource: workspaceMutationSource(input.source), userId: actingUserId() },
    [{ solutionId: solution.id, horizon: input.horizon, isPrivate: input.isPrivate, id: promotionId }],
  )
  if (result.existing[0]) {
    // The solution already has an ACTIVE roadmap item: promoting it again is a no-op that returns that item.
    const item = await prisma.roadmapItem.findUnique({ where: { id: result.existing[0].itemId } })
    if (item) return ok("Solution is already on the roadmap.", promotionData(item, solution.opportunity.title, false))
  }
  if (result.conflicts[0]) {
    // Lost an insert race for the same operationId: converge on the stored row.
    const item = await prisma.roadmapItem.findUnique({ where: { id: promotionId } })
    if (!item || !sameOperation(item)) throw new RoadmapPromotionConflict("The operationId was already used for a different roadmap promotion.")
    return ok("Solution promoted to roadmap.", promotionData(item, solution.opportunity.title, false))
  }
  const created = result.created[0]
  const item = created && (await prisma.roadmapItem.findUnique({ where: { id: created.id } }))
  if (!item) return fail("Solution not found.")
  return ok("Solution promoted to roadmap.", promotionData(item, solution.opportunity.title, true))
}

function promotionData(item: { id: string; title: string; horizon: string; isPrivate: boolean; solutionId: string | null; opportunityId: string | null; squadId: string | null; startDate: Date | null; endDate: Date | null }, opportunityTitle: string, created: boolean) {
  return { id: item.id, title: item.title, horizon: item.horizon, isPrivate: item.isPrivate, solutionId: item.solutionId, opportunityId: item.opportunityId, opportunityTitle, squadId: item.squadId, startDate: item.startDate, endDate: item.endDate, created }
}

export async function updateRoadmapItem(input: {
  itemId: string; keyResultId?: string | null; opportunityId?: string | null; solutionId?: string | null; squadId?: string | null
  horizon?: "NOW" | "NEXT" | "LATER" | "LAUNCHING" | "LAUNCHED" | "SHIPPED"; status?: "ACTIVE" | "ARCHIVED"
  title?: string; description?: string | null; startDate?: string | null; endDate?: string | null; isPrivate?: boolean
  source?: ProgrammaticSource
}) {
  const prisma = getPrisma()
  const item = await prisma.roadmapItem.findUnique({ where: { id: input.itemId }, select: { id: true, workspaceId: true } })
  if (!item) return fail(`Roadmap item "${input.itemId}" not found.`)
  if (input.horizon === "LAUNCHING" || input.horizon === "LAUNCHED") {
    const workspace = await prisma.workspace.findUnique({ where: { id: item.workspaceId }, select: { launchWorkflowEnabled: true } })
    if (!workspace?.launchWorkflowEnabled) return fail(LAUNCH_WORKFLOW_DISABLED_MESSAGE)
    if (input.horizon === "LAUNCHING") return fail("Cannot set horizon to LAUNCHING directly — use set_launch_tier, which also picks a launch tier and attaches a checklist.")
    return fail("Cannot set horizon to LAUNCHED — the launch-readiness gate for this transition isn't implemented yet.")
  }
  const checks: Promise<unknown>[] = []
  if (input.squadId) checks.push(prisma.squad.findFirst({ where: { id: input.squadId, workspaceId: item.workspaceId }, select: { id: true } }))
  if (input.solutionId) checks.push(prisma.solution.findFirst({ where: { id: input.solutionId, workspaceId: item.workspaceId }, select: { id: true } }))
  if (input.opportunityId) checks.push(prisma.opportunity.findFirst({ where: { id: input.opportunityId, workspaceId: item.workspaceId }, select: { id: true } }))
  if (input.keyResultId) checks.push(prisma.keyResult.findFirst({ where: { id: input.keyResultId, objective: { workspaceId: item.workspaceId } }, select: { id: true } }))
  if ((await Promise.all(checks)).some((row) => !row)) return fail("A linked resource was not found in this workspace.")
  const data: Record<string, unknown> = { updatedAt: new Date() }
  for (const key of ["keyResultId", "opportunityId", "solutionId", "squadId", "horizon", "status", "isPrivate"] as const) if (input[key] !== undefined) data[key] = input[key]
  if (input.title !== undefined) data.title = input.title.trim()
  if (input.description !== undefined) data.description = input.description?.trim() || null
  if (input.startDate !== undefined) data.startDate = input.startDate ? new Date(input.startDate) : null
  if (input.endDate !== undefined) data.endDate = input.endDate ? new Date(input.endDate) : null
  // A hand-edited schedule stops the item following its solution (migration 075).
  if (input.startDate !== undefined || input.endDate !== undefined || input.horizon !== undefined) data.scheduleEditedAt = new Date()
  const updated = await captureWorkspaceMutation(prisma, "roadmapItem", "update", workspaceMutationSource(input.source), input.itemId, (tx) => tx.roadmapItem.update({ where: { id: input.itemId }, data }))
  const formatUtcDate = (date: Date) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).format(date)
  return ok(
    `**Roadmap item updated**\nID: ${updated.id}\nTitle: ${updated.title}\n` +
      `Horizon: ${updated.horizon}\nStatus: ${updated.status}` +
      (updated.isPrivate ? "\nPrivate: yes (hidden from public portal)" : "") +
      (updated.solutionId ? `\nLinked Solution: ${updated.solutionId}` : "") +
      (updated.startDate || updated.endDate
        ? `\nDates: ${updated.startDate ? formatUtcDate(updated.startDate) : "?"} – ${updated.endDate ? formatUtcDate(updated.endDate) : "?"}`
        : ""),
    { id: updated.id, title: updated.title, horizon: updated.horizon, status: updated.status, isPrivate: updated.isPrivate, solutionId: updated.solutionId, startDate: updated.startDate, endDate: updated.endDate },
  )
}

interface ChecklistItemInput {
  label: string
  description?: string
}

// ─── create_checklist_template ───────────────────────────────────────────────

export async function createChecklistTemplate({
  workspaceId,
  tier,
  name,
  description,
  items,
}: {
  workspaceId: string
  tier: LaunchTier
  name: string
  description?: string
  items: ChecklistItemInput[]
}) {
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (!workspace) {
    return fail(`Workspace "${workspaceId}" not found.`)
  }

  const template = await withWorkspaceUpdates(prisma, async tx => {
    const created = await tx.checklistTemplate.create({ data: { workspaceId, tier, name: name.trim(), description } })
    if (items.length > 0) {
      await tx.checklistTemplateItem.createMany({
        data: items.map((item, i) => ({ checklistTemplateId: created.id, label: item.label, description: item.description, order: i })),
      })
    }
    return created
  }, { atomic: true })

  return ok(
    `**Checklist template created:** ${template.name}\n` +
      `Tier: ${tier}\n` +
      `Items: ${items.length}\n` +
      `ID: ${template.id}`,
    {
      id: template.id,
      name: template.name,
      tier,
      items: items.map((item, i) => ({ label: item.label, description: item.description, order: i })),
    },
  )
}

// ─── list_checklist_templates ────────────────────────────────────────────────

export async function listChecklistTemplates({
  workspaceId,
  tier,
}: {
  workspaceId: string
  tier?: LaunchTier
}) {
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (!workspace) {
    return fail(`Workspace "${workspaceId}" not found.`)
  }

  const templates = await prisma.checklistTemplate.findMany({
    where: { workspaceId, ...(tier ? { tier } : {}) },
    include: { items: { orderBy: { order: "asc" } } },
    orderBy: { createdAt: "desc" },
  })

  if (!templates.length) {
    return fail("No checklist templates found.")
  }

  const lines = templates.map((t) =>
    `• **${t.name}** [${t.status}] Tier: ${t.tier} — ${t.items.length} item(s)\n` +
      `  ID: ${t.id}` +
      (t.description ? `\n  ${t.description}` : "")
  )
  return ok(lines.join("\n\n"), {
    items: templates.map((t) => ({
      id: t.id,
      name: t.name,
      tier: t.tier,
      status: t.status,
      itemCount: t.items.length,
    })),
    count: templates.length,
  })
}

// ─── set_launch_tier ──────────────────────────────────────────────────────────

export async function setLaunchTier({
  itemId,
  tier,
  templateId,
}: {
  itemId: string
  tier: LaunchTier
  templateId?: string
}) {
  const prisma = getPrisma()

  const item = await prisma.roadmapItem.findUnique({
    where: { id: itemId },
    select: { id: true, title: true, workspaceId: true, horizon: true },
  })
  if (!item) {
    return fail(`Roadmap item "${itemId}" not found.`)
  }

  if (item.horizon === "LAUNCHING" || item.horizon === "LAUNCHED") {
    return fail(`Roadmap item "${item.title}" is already ${item.horizon}. A new launch tier cannot be set on an item that has already started launching.`)
  }

  // Resolve the template: explicit templateId (tier-validated) or the
  // workspace's most recent ACTIVE template for this tier.
  let template
  if (templateId) {
    template = await prisma.checklistTemplate.findUnique({
      where: { id: templateId },
      include: { items: { orderBy: { order: "asc" } } },
    })
    if (!template) {
      return fail(`Checklist template "${templateId}" not found.`)
    }
    if (template.tier !== tier) {
      return fail(`Checklist template "${template.name}" is for tier ${template.tier}, not ${tier}. Pass a matching templateId or omit it to use the workspace's active ${tier} template.`)
    }
  } else {
    template = await prisma.checklistTemplate.findFirst({
      where: { workspaceId: item.workspaceId, tier, status: "ACTIVE" },
      include: { items: { orderBy: { order: "asc" } } },
      orderBy: { createdAt: "desc" },
    })
    if (!template) {
      return fail(
        `No active checklist template found for tier ${tier} in this workspace. ` +
          `Use create_checklist_template to create one, or pass an explicit templateId.`
      )
    }
  }

  const { launchChecklistId } = await setLaunchTierCore(item.id, tier, {
    id: template.id,
    name: template.name,
    tier: template.tier,
    items: template.items.map((i) => ({ label: i.label, description: i.description, order: i.order })),
  }, item.workspaceId, prisma, "MCP")

  return ok(
    `**Launch tier set:** ${tier}\n` +
      `Roadmap item: ${item.title}\n` +
      `New horizon: LAUNCHING\n` +
      `Checklist: ${template.name} (${template.items.length} item(s))\n` +
      `ID: ${launchChecklistId}`,
    {
      item: { id: item.id, title: item.title, tier, horizon: "LAUNCHING" as const },
      checklist: {
        id: launchChecklistId,
        name: template.name,
        tier: template.tier,
        itemCount: template.items.length,
      },
    },
  )
}

// ─── get_launch_checklist ─────────────────────────────────────────────────────

export async function getLaunchChecklist({ roadmapItemId }: { roadmapItemId: string }) {
  const prisma = getPrisma()

  const item = await prisma.roadmapItem.findUnique({
    where: { id: roadmapItemId },
    select: { id: true, title: true },
  })
  if (!item) {
    return fail(`Roadmap item "${roadmapItemId}" not found.`)
  }

  const checklist = await prisma.launchChecklist.findUnique({
    where: { roadmapItemId },
    include: { items: { orderBy: { order: "asc" } } },
  })
  if (!checklist) {
    return fail(`Roadmap item "${item.title}" has no launch checklist yet. Use set_launch_tier to create one.`)
  }

  const done = checklist.items.filter((i) => i.status === "DONE").length
  const skipped = checklist.items.filter((i) => i.status === "SKIPPED").length
  const pending = checklist.items.filter((i) => i.status === "PENDING").length

  const lines = [
    `**Launch checklist for:** ${item.title}`,
    `Tier: ${checklist.tier}`,
    `Status: ${done} done, ${skipped} skipped, ${pending} pending (of ${checklist.items.length})`,
    `ID: ${checklist.id}`,
    "",
    "Items:",
    ...checklist.items.map((i) =>
      `• [${i.status}] ${i.label}` +
      (i.description ? ` — ${i.description}` : "") +
      `\n  ID: ${i.id}`
    ),
  ]
  return ok(lines.join("\n"), {
    items: checklist.items.map((i) => ({ id: i.id, label: i.label, status: i.status })),
    count: checklist.items.length,
  })
}

// ─── update_launch_checklist_item ────────────────────────────────────────────

export async function updateLaunchChecklistItem({
  itemId,
  status,
}: {
  itemId: string
  status: "PENDING" | "DONE" | "SKIPPED"
}) {
  const updated = await updateChecklistItemCore(itemId, status)
  if (!updated) {
    return fail(`Launch checklist item "${itemId}" not found.`)
  }

  return ok(
    `**Checklist item updated:** ${updated.label}\n` +
      `Status: ${updated.status}\n` +
      `ID: ${updated.id}`,
    { id: updated.id, status: updated.status },
  )
}
