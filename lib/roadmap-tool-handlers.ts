/**
 * Handler functions for the Launch Tiers + Checklist Templates MCP tools.
 * Extracted into this module so they can be unit-tested without the MCP server layer,
 * following the same shape as lib/scoring-tool-handlers.ts.
 *
 * No extra role/membership gate beyond validateMcpAuth (API-key auth only) — matches
 * every other existing MCP tool.
 */

import { randomUUID } from "crypto"
import getPrisma from "@/lib/db"
import type { LaunchTier, ChecklistTemplateSnapshot } from "@/lib/types"

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
    return { content: [{ type: "text" as const, text: `Workspace "${workspaceId}" not found.` }] }
  }

  const template = await prisma.checklistTemplate.create({
    data: { workspaceId, tier, name: name.trim(), description },
  })

  if (items.length > 0) {
    await prisma.checklistTemplateItem.createMany({
      data: items.map((item, i) => ({
        checklistTemplateId: template.id,
        label: item.label,
        description: item.description,
        order: i,
      })),
    })
  }

  return {
    content: [{
      type: "text" as const,
      text:
        `**Checklist template created:** ${template.name}\n` +
        `Tier: ${tier}\n` +
        `Items: ${items.length}\n` +
        `ID: ${template.id}`,
    }],
  }
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
    return { content: [{ type: "text" as const, text: `Workspace "${workspaceId}" not found.` }] }
  }

  const templates = await prisma.checklistTemplate.findMany({
    where: { workspaceId, ...(tier ? { tier } : {}) },
    include: { items: { orderBy: { order: "asc" } } },
    orderBy: { createdAt: "desc" },
  })

  if (!templates.length) {
    return { content: [{ type: "text" as const, text: "No checklist templates found." }] }
  }

  const lines = templates.map((t) =>
    `• **${t.name}** [${t.status}] Tier: ${t.tier} — ${t.items.length} item(s)\n` +
      `  ID: ${t.id}` +
      (t.description ? `\n  ${t.description}` : "")
  )
  return { content: [{ type: "text" as const, text: lines.join("\n\n") }] }
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
    return { content: [{ type: "text" as const, text: `Roadmap item "${itemId}" not found.` }] }
  }

  if (item.horizon === "LAUNCHING" || item.horizon === "LAUNCHED") {
    return {
      content: [{
        type: "text" as const,
        text: `Roadmap item "${item.title}" is already ${item.horizon}. A new launch tier cannot be set on an item that has already started launching.`,
      }],
    }
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
      return { content: [{ type: "text" as const, text: `Checklist template "${templateId}" not found.` }] }
    }
    if (template.tier !== tier) {
      return {
        content: [{
          type: "text" as const,
          text: `Checklist template "${template.name}" is for tier ${template.tier}, not ${tier}. Pass a matching templateId or omit it to use the workspace's active ${tier} template.`,
        }],
      }
    }
  } else {
    template = await prisma.checklistTemplate.findFirst({
      where: { workspaceId: item.workspaceId, tier, status: "ACTIVE" },
      include: { items: { orderBy: { order: "asc" } } },
      orderBy: { createdAt: "desc" },
    })
    if (!template) {
      return {
        content: [{
          type: "text" as const,
          text:
            `No active checklist template found for tier ${tier} in this workspace. ` +
            `Use create_checklist_template to create one, or pass an explicit templateId.`,
        }],
      }
    }
  }

  const snapshot: ChecklistTemplateSnapshot = {
    templateId: template.id,
    templateName: template.name,
    tier: template.tier as LaunchTier,
    items: template.items.map((i) => ({ label: i.label, description: i.description, order: i.order })),
  }

  const launchChecklistId = randomUUID()

  await prisma.$transaction([
    prisma.launchChecklist.create({
      data: {
        id: launchChecklistId,
        roadmapItemId: item.id,
        checklistTemplateId: template.id,
        tier,
        templateSnapshot: JSON.stringify(snapshot),
      },
    }),
    prisma.launchChecklistItem.createMany({
      data: template.items.map((i) => ({
        launchChecklistId,
        label: i.label,
        description: i.description,
        order: i.order,
      })),
    }),
    prisma.roadmapItem.update({
      where: { id: item.id },
      data: { horizon: "LAUNCHING", updatedAt: new Date() },
    }),
  ])

  return {
    content: [{
      type: "text" as const,
      text:
        `**Launch tier set:** ${tier}\n` +
        `Roadmap item: ${item.title}\n` +
        `New horizon: LAUNCHING\n` +
        `Checklist: ${template.name} (${template.items.length} item(s))\n` +
        `ID: ${launchChecklistId}`,
    }],
  }
}

// ─── get_launch_checklist ─────────────────────────────────────────────────────

export async function getLaunchChecklist({ roadmapItemId }: { roadmapItemId: string }) {
  const prisma = getPrisma()

  const item = await prisma.roadmapItem.findUnique({
    where: { id: roadmapItemId },
    select: { id: true, title: true },
  })
  if (!item) {
    return { content: [{ type: "text" as const, text: `Roadmap item "${roadmapItemId}" not found.` }] }
  }

  const checklist = await prisma.launchChecklist.findUnique({
    where: { roadmapItemId },
    include: { items: { orderBy: { order: "asc" } } },
  })
  if (!checklist) {
    return {
      content: [{
        type: "text" as const,
        text: `Roadmap item "${item.title}" has no launch checklist yet. Use set_launch_tier to create one.`,
      }],
    }
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
  return { content: [{ type: "text" as const, text: lines.join("\n") }] }
}

// ─── update_launch_checklist_item ────────────────────────────────────────────

export async function updateLaunchChecklistItem({
  itemId,
  status,
}: {
  itemId: string
  status: "PENDING" | "DONE" | "SKIPPED"
}) {
  const prisma = getPrisma()

  const existing = await prisma.launchChecklistItem.findUnique({
    where: { id: itemId },
    select: { id: true, label: true },
  })
  if (!existing) {
    return { content: [{ type: "text" as const, text: `Launch checklist item "${itemId}" not found.` }] }
  }

  const updated = await prisma.launchChecklistItem.update({
    where: { id: itemId },
    data: {
      status,
      completedAt: status === "DONE" ? new Date() : null,
      updatedAt: new Date(),
    },
  })

  return {
    content: [{
      type: "text" as const,
      text:
        `**Checklist item updated:** ${updated.label}\n` +
        `Status: ${updated.status}\n` +
        `ID: ${updated.id}`,
    }],
  }
}
