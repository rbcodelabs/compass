/**
 * Plain-data core for Launch Tiers + Checklists, shared by the MCP tool
 * handlers (lib/roadmap-tool-handlers.ts) and the web server actions
 * (app/[orgSlug]/[workspaceSlug]/roadmap/launch-actions.ts). The MCP handlers
 * format the results into their existing text output byte-for-byte; the web
 * actions return structured data. Keeping the DB logic here means both paths
 * enter LAUNCHING through the exact same transaction.
 */
import { randomUUID } from "crypto";
import getPrisma from "@/lib/db";
import { workspaceUpdatesAvailable, recordWorkspaceUpdate } from "@/lib/workspace-updates-capture";
import { workspaceMutationActor } from "@/lib/workspace-update-mutations";
import type { LaunchTier, ChecklistTemplateSnapshot, LaunchChecklistItemStatus } from "@/lib/types";
import { DEFAULT_CHECKLIST_TEMPLATES } from "@/lib/launch-defaults";

/** A template plus its ordered items — the shape the attach transaction needs. */
export interface ResolvedTemplate {
  id: string;
  name: string;
  tier: string;
  items: { label: string; description: string | null; order: number }[];
}

/**
 * Shared, actionable rejection message for every launch-gated surface (web
 * actions, MCP tool gates, and this choke-point) — named so callers/tests can
 * assert on it without duplicating the copy.
 */
export const LAUNCH_WORKFLOW_DISABLED_MESSAGE =
  "The marketing launch workflow is disabled for this workspace. A workspace admin can turn it on in Settings → Marketing launch.";

/**
 * Gate for the entire marketing-launch surface: throws when the workspace
 * hasn't turned on Workspace.launchWorkflowEnabled. Called from setLaunchTierCore
 * below (so every caller inherits it for free) and independently from the web
 * actions / MCP tool gates that don't route through setLaunchTierCore.
 */
export async function assertLaunchWorkflowEnabled(workspaceId: string): Promise<void> {
  const prisma = getPrisma();
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { launchWorkflowEnabled: true },
  });
  if (!workspace?.launchWorkflowEnabled) {
    throw new Error(LAUNCH_WORKFLOW_DISABLED_MESSAGE);
  }
}

/**
 * The shared write: snapshot the template, create the LaunchChecklist + its
 * items, and flip the roadmap item to LAUNCHING — all in one transaction, in
 * that order. Callers are responsible for having already looked up the item
 * and guarded against an item that's already launching.
 */
export async function setLaunchTierCore(
  itemId: string,
  tier: LaunchTier,
  template: ResolvedTemplate,
  workspaceId: string,
  source: "UI" | "MCP" = "UI",
): Promise<{ launchChecklistId: string; itemCount: number }> {
  await assertLaunchWorkflowEnabled(workspaceId);

  const prisma = getPrisma();

  const snapshot: ChecklistTemplateSnapshot = {
    templateId: template.id,
    templateName: template.name,
    tier: template.tier as LaunchTier,
    items: template.items.map((i) => ({ label: i.label, description: i.description, order: i.order })),
  };

  const launchChecklistId = randomUUID();
  const capture = await workspaceUpdatesAvailable(prisma);
  const actor = capture ? await workspaceMutationActor(source) : null;

  await prisma.$transaction(async (tx) => {
    const before = capture ? await tx.roadmapItem.findUnique({ where: { id: itemId }, select: { horizon: true } }) : null;
    await tx.launchChecklist.create({
      data: {
        id: launchChecklistId,
        roadmapItemId: itemId,
        checklistTemplateId: template.id,
        tier,
        templateSnapshot: JSON.stringify(snapshot),
      },
    })
    await tx.launchChecklistItem.createMany({
      data: template.items.map((i) => ({
        launchChecklistId,
        label: i.label,
        description: i.description,
        order: i.order,
      })),
    })
    await tx.roadmapItem.update({
      where: { id: itemId },
      data: { horizon: "LAUNCHING", updatedAt: new Date() },
    })
    if (capture && actor) await recordWorkspaceUpdate(tx, { workspaceId, entityType: "ROADMAP_ITEM", entityId: itemId, kind: "STATUS_CHANGED", before: before?.horizon, after: "LAUNCHING", ...actor });
  });

  return { launchChecklistId, itemCount: template.items.length };
}

/**
 * Resolve the workspace's active template for a tier, auto-seeding a sensible
 * default (DEFAULT_CHECKLIST_TEMPLATES) the first time a tier is used. This is
 * the web-only "just works" path — the MCP set_launch_tier deliberately does
 * NOT seed (it errors, pointing agents at create_checklist_template).
 */
export async function resolveOrSeedTemplate(
  workspaceId: string,
  tier: LaunchTier
): Promise<ResolvedTemplate> {
  const prisma = getPrisma();

  const existing = await prisma.checklistTemplate.findFirst({
    where: { workspaceId, tier, status: "ACTIVE" },
    include: { items: { orderBy: { order: "asc" } } },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    return {
      id: existing.id,
      name: existing.name,
      tier: existing.tier,
      items: existing.items.map((i) => ({ label: i.label, description: i.description, order: i.order })),
    };
  }

  const def = DEFAULT_CHECKLIST_TEMPLATES[tier];
  const created = await prisma.checklistTemplate.create({
    data: { workspaceId, tier, name: def.name, description: def.description },
  });
  if (def.items.length > 0) {
    await prisma.checklistTemplateItem.createMany({
      data: def.items.map((item, i) => ({
        checklistTemplateId: created.id,
        label: item.label,
        description: item.description,
        order: i,
      })),
    });
  }

  return {
    id: created.id,
    name: created.name,
    tier,
    items: def.items.map((item, i) => ({
      label: item.label,
      description: item.description ?? null,
      order: i,
    })),
  };
}

/**
 * Update one checklist item's status, setting/clearing completedAt to match.
 * Returns the updated row, or null if no such item exists.
 */
export async function updateChecklistItemCore(
  itemId: string,
  status: LaunchChecklistItemStatus
): Promise<{ id: string; label: string; status: string } | null> {
  const prisma = getPrisma();

  const existing = await prisma.launchChecklistItem.findUnique({
    where: { id: itemId },
    select: { id: true, label: true },
  });
  if (!existing) return null;

  const updated = await prisma.launchChecklistItem.update({
    where: { id: itemId },
    data: {
      status,
      completedAt: status === "DONE" ? new Date() : null,
      updatedAt: new Date(),
    },
  });

  return { id: updated.id, label: updated.label, status: updated.status };
}

/** Roll a checklist's items up into a compact progress summary for the card/panel. */
export function checklistProgress(items: { status: string }[]): {
  done: number;
  skipped: number;
  pending: number;
  total: number;
} {
  return {
    done: items.filter((i) => i.status === "DONE").length,
    skipped: items.filter((i) => i.status === "SKIPPED").length,
    pending: items.filter((i) => i.status === "PENDING").length,
    total: items.length,
  };
}
