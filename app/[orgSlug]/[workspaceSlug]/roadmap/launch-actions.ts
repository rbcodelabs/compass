"use server";

/**
 * Server actions for the roadmap-item panel's Launch section. These are
 * deliberately separate from the generic entity-field PATCH: setLaunchTier is
 * a multi-statement transaction (create checklist + items + flip horizon), and
 * a LaunchChecklistItem isn't a panel EntityType at all. Both wrap the shared
 * core in lib/launch-checklist.ts plus a session guard and a workspace-scoped
 * ownership check — the same IDOR boundary the panel reads/writes enforce.
 */
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import getPrisma from "@/lib/db";
import type { LaunchTier, LaunchChecklistItemStatus } from "@/lib/types";
import { isLaunchHorizon } from "@/lib/roadmap";
import {
  resolveOrSeedTemplate,
  setLaunchTierCore,
  updateChecklistItemCore,
} from "@/lib/launch-checklist";

/**
 * Pick a launch tier for a roadmap item: auto-seed/resolve the tier's active
 * template, attach a fresh checklist, and move the item to LAUNCHING — all in
 * one transaction. Rejects an item that's already launching.
 */
export async function setLaunchTier(
  itemId: string,
  tier: LaunchTier,
  workspaceId: string
): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const prisma = getPrisma();
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: session.user.id } },
    select: { id: true },
  });
  if (!member) throw new Error("Workspace not found");
  const item = await prisma.roadmapItem.findFirst({
    where: { id: itemId, workspaceId },
    select: { id: true, horizon: true },
  });
  if (!item) throw new Error("Roadmap item not found");
  if (isLaunchHorizon(item.horizon)) {
    throw new Error(`This item is already ${item.horizon} — a new launch tier can't be set.`);
  }

  const template = await resolveOrSeedTemplate(workspaceId, tier);
  await setLaunchTierCore(item.id, tier, template);

  revalidatePath("/", "layout");
}

/**
 * Set one checklist item's status (PENDING / DONE / SKIPPED). Scoped to the
 * workspace via the checklist → roadmap item chain so a checklist item can no
 * more be updated across workspaces than any other panel write.
 */
export async function updateLaunchChecklistItem(
  itemId: string,
  status: LaunchChecklistItemStatus,
  workspaceId: string
): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const prisma = getPrisma();
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: session.user.id } },
    select: { id: true },
  });
  if (!member) throw new Error("Workspace not found");
  const owned = await prisma.launchChecklistItem.findFirst({
    where: { id: itemId, launchChecklist: { roadmapItem: { workspaceId } } },
    select: { id: true },
  });
  if (!owned) throw new Error("Checklist item not found");

  await updateChecklistItemCore(itemId, status);

  revalidatePath("/", "layout");
}
