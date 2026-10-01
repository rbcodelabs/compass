"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import getPrisma from "@/lib/db";
import { getHumanActivityPrisma } from "@/lib/analytics/activity";
import { auth } from "@/auth";
import { getWorkspace } from "@/lib/workspace";
import { assertWorkspaceWritable } from "@/lib/workspace-context";
import { setObjectiveParentKeyResult } from "@/lib/okr-hierarchy";
import { requireProductEntity, requireProductWorkspace } from "@/lib/product-action-auth";
import { drainAfterParentDelete, drainLegacyLinksForOpportunities, drainLinksFor } from "@/lib/typed-links";

// ─── Create Cycle ─────────────────────────────────────────────────────────────

const CreateCycleSchema = z.object({
  title: z.string().min(1, "Title is required"),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
});

export async function createCycle(
  workspaceId: string,
  orgSlug: string,
  workspaceSlug: string,
  formData: FormData
) {
  const parsed = CreateCycleSchema.safeParse({
    title: formData.get("title"),
    startDate: formData.get("startDate"),
    endDate: formData.get("endDate"),
  });

  if (!parsed.success) {
    throw new Error(parsed.error.issues[0].message);
  }

  // workspaceId arrives from the client: prove the caller is a member of it.
  await requireProductWorkspace(workspaceId);
  const prisma = getPrisma();

  const cycle = await prisma.oKRCycle.create({
    data: {
      workspaceId,
      title: parsed.data.title,
      startDate: parsed.data.startDate,
      endDate: parsed.data.endDate,
    },
  });

  redirect(`/${orgSlug}/${workspaceSlug}/okrs/${cycle.id}`);
}

// ─── Create Objective ─────────────────────────────────────────────────────────

const CreateObjectiveSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  owner: z.string().optional(),
  squadId: z.string().uuid().optional(),
});

export async function createObjective(
  cycleId: string,
  orgSlug: string,
  workspaceSlug: string,
  formData: FormData
) {
  const parsed = CreateObjectiveSchema.safeParse({
    title: formData.get("title"),
    description: formData.get("description") || undefined,
    owner: formData.get("owner") || undefined,
    squadId: formData.get("squadId") || undefined,
  });

  if (!parsed.success) {
    throw new Error(parsed.error.issues[0].message);
  }

  // The Objective's workspace is derived from the authorized cycle, never from
  // client input, so it cannot disagree with the cycle it is created under.
  const { workspaceId } = await requireProductEntity("okrCycle", cycleId);
  const prisma = getPrisma();
  // A client-supplied squad must live in the same workspace as the cycle.
  if (parsed.data.squadId) await requireProductEntity("squad", parsed.data.squadId, workspaceId);

  await prisma.objective.create({
    data: {
      workspaceId,
      cycleId,
      title: parsed.data.title,
      description: parsed.data.description,
      owner: parsed.data.owner,
      squadId: parsed.data.squadId ?? null,
    },
  });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/okrs`, "layout");
}

// ─── Add Key Result ───────────────────────────────────────────────────────────

const AddKeyResultSchema = z.object({
  title: z.string().min(1, "Title is required"),
  target: z.coerce.number().positive("Target must be a positive number"),
  unit: z.string().optional(),
});

export async function addKeyResult(
  objectiveId: string,
  orgSlug: string,
  workspaceSlug: string,
  formData: FormData
) {
  const parsed = AddKeyResultSchema.safeParse({
    title: formData.get("title"),
    target: formData.get("target"),
    unit: formData.get("unit") || undefined,
  });

  if (!parsed.success) {
    throw new Error(parsed.error.issues[0].message);
  }

  await requireProductEntity("objective", objectiveId);
  const prisma = getPrisma();

  await prisma.keyResult.create({
    data: {
      objectiveId,
      title: parsed.data.title,
      target: parsed.data.target,
      unit: parsed.data.unit,
    },
  });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/okrs`, "layout");
}

// ─── Log Check-in ─────────────────────────────────────────────────────────────

const LogCheckInSchema = z.object({
  value: z.coerce.number(),
  note: z.string().optional(),
});

export async function logCheckIn(
  keyResultId: string,
  orgSlug: string,
  workspaceSlug: string,
  formData: FormData
) {
  const parsed = LogCheckInSchema.safeParse({
    value: formData.get("value"),
    note: formData.get("note") || undefined,
  });

  if (!parsed.success) {
    throw new Error(parsed.error.issues[0].message);
  }

  await requireProductEntity("keyResult", keyResultId);
  // Create check-in record and update the KR's current value in one transaction.
  await getHumanActivityPrisma().$transaction(async tx => {
    await tx.checkIn.create({
      data: {
        keyResultId,
        value: parsed.data.value,
        note: parsed.data.note,
      },
    })
    await tx.keyResult.update({
      where: { id: keyResultId },
      data: { current: parsed.data.value },
    })
  });

  // Revalidate both the cycle detail page (where check-in is triggered) and the
  // cycles index (where cycle cards show aggregate progress).
  revalidatePath(`/${orgSlug}/${workspaceSlug}/okrs`, "layout");
}

// ─── Set Objective Parent KR ──────────────────────────────────────────────────

export async function setObjectiveParentKR(
  objectiveId: string,
  keyResultId: string | null,
  orgSlug: string,
  workspaceSlug: string
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id);
  if (!workspace) throw new Error("Workspace not found");
  assertWorkspaceWritable(workspace);

  await setObjectiveParentKeyResult({
    workspaceId: workspace.id,
    objectiveId,
    keyResultId,
  });
  revalidatePath(`/${orgSlug}/${workspaceSlug}/okrs`, "layout");
}

// ─── Update Objective Status ──────────────────────────────────────────────────

const ObjectiveStatusSchema = z.enum([
  "ON_TRACK",
  "AT_RISK",
  "OFF_TRACK",
  "COMPLETE",
]);

export async function updateObjectiveStatus(
  objectiveId: string,
  status: z.infer<typeof ObjectiveStatusSchema>,
  orgSlug: string,
  workspaceSlug: string
) {
  const parsed = ObjectiveStatusSchema.safeParse(status);

  if (!parsed.success) {
    throw new Error("Invalid status value");
  }

  await requireProductEntity("objective", objectiveId);
  const prisma = getPrisma();

  await prisma.objective.update({
    where: { id: objectiveId },
    data: { status: parsed.data },
  });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/okrs`, "layout");
}

// ─── Delete Objective ─────────────────────────────────────────────────────────

export async function deleteObjective(
  objectiveId: string,
  revalidatePathStr: string
) {
  await requireProductEntity("objective", objectiveId);
  const prisma = getPrisma();
  // The objective is deleted FIRST; a refusal (Restrict: it still has key results) throws here with every link untouched. Its links are
  // drained AFTER, in committed passes of at most 500 links (no foreign key reaches the link tables, and one transaction could not hold
  // an objective's links under DSQL's 3,000-row cap). A failed drain is logged and swallowed: the delete succeeded, and leftovers are
  // reported by linkIntegrity and pruned by 072.
  await prisma.objective.delete({ where: { id: objectiveId } });
  await drainAfterParentDelete("ui.deleteObjective", () => drainLinksFor(prisma, "objective", [objectiveId]));
  revalidatePath(revalidatePathStr);
}

// ─── Delete Key Result ────────────────────────────────────────────────────────

export async function deleteKeyResult(
  keyResultId: string,
  revalidatePathStr: string
) {
  await requireProductEntity("keyResult", keyResultId);
  const prisma = getPrisma();
  // Read BEFORE the delete: the relation's SetNull clears these pointers, and the LEGACY links they implied are what goes afterwards.
  const keyResult = await prisma.keyResult.findUnique({ where: { id: keyResultId }, select: { objectiveId: true } });
  const pointing = await prisma.opportunity.findMany({ where: { linkedKeyResultId: keyResultId }, select: { id: true } });
  // Delete the key result FIRST. It can be refused under relationMode="prisma" (Restrict: supporting objectives, check-ins); a refusal
  // throws here and no link has been touched. Links are drained AFTER (see deleteObjective): the LEGACY links implied by the pointers
  // (DIRECT links are the user's own and stay) and every solution link to this key result. A failed drain is logged and swallowed.
  await prisma.keyResult.delete({ where: { id: keyResultId } });
  await drainAfterParentDelete("ui.deleteKeyResult.legacy", () => drainLegacyLinksForOpportunities(prisma, pointing.map((o) => o.id), keyResult?.objectiveId));
  await drainAfterParentDelete("ui.deleteKeyResult.solution", () => drainLinksFor(prisma, "keyResult", [keyResultId]));
  revalidatePath(revalidatePathStr);
}

// ─── Reorder Objective ────────────────────────────────────────────────────────

export async function reorderObjective(
  objectiveId: string,
  sortOrder: number,
  revalidatePathStr: string
) {
  await requireProductEntity("objective", objectiveId);
  const prisma = getPrisma();
  await prisma.objective.update({
    where: { id: objectiveId },
    data: { sortOrder },
  });
  revalidatePath(revalidatePathStr);
}

// ─── Reorder Key Result ───────────────────────────────────────────────────────

export async function reorderKeyResult(
  keyResultId: string,
  sortOrder: number,
  revalidatePathStr: string
) {
  await requireProductEntity("keyResult", keyResultId);
  const prisma = getPrisma();
  await prisma.keyResult.update({
    where: { id: keyResultId },
    data: { sortOrder },
  });
  revalidatePath(revalidatePathStr);
}
