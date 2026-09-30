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
import { requireProductEntity, requireProductWorkspace, requireProductWorkspaceBySlug } from "@/lib/product-action-auth";

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

/** Authorized workspace for a new Objective: the cycle's when given, else the membership-checked slugs'. */
async function resolveObjectiveWorkspaceId(cycleId: string | null, orgSlug: string, workspaceSlug: string): Promise<string> {
  if (cycleId) return (await requireProductEntity("okrCycle", cycleId)).workspaceId;
  return requireProductWorkspaceBySlug(orgSlug, workspaceSlug);
}

/**
 * `cycleId === null` creates a cycle-less (persistent) Objective; its workspace
 * then comes from the membership-checked org/workspace slugs instead of a cycle.
 */
export async function createObjective(
  cycleId: string | null,
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

  // The Objective's workspace is derived from the authorized cycle (or, with no
  // cycle, from the membership-checked slugs), never from client-supplied ids,
  // so it cannot disagree with the cycle it is created under.
  const workspaceId = await resolveObjectiveWorkspaceId(cycleId, orgSlug, workspaceSlug);
  const prisma = getPrisma();
  // A client-supplied squad must live in the same workspace as the cycle.
  if (parsed.data.squadId) await requireProductEntity("squad", parsed.data.squadId, workspaceId);

  await prisma.objective.create({
    data: {
      workspaceId,
      cycleId: cycleId ?? null,
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
  await prisma.objective.delete({ where: { id: objectiveId } });
  revalidatePath(revalidatePathStr);
}

// ─── Delete Key Result ────────────────────────────────────────────────────────

export async function deleteKeyResult(
  keyResultId: string,
  revalidatePathStr: string
) {
  await requireProductEntity("keyResult", keyResultId);
  const prisma = getPrisma();
  await prisma.keyResult.delete({ where: { id: keyResultId } });
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
