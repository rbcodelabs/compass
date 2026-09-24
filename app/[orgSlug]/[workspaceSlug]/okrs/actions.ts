"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import getPrisma from "@/lib/db";
import { getHumanActivityPrisma } from "@/lib/analytics/activity";
import { auth } from "@/auth";
import { getWorkspace } from "@/lib/workspace";
import { setObjectiveParentKeyResult } from "@/lib/okr-hierarchy";

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

  const prisma = getPrisma();

  await prisma.objective.create({
    data: {
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
  const prisma = getPrisma();
  await prisma.objective.delete({ where: { id: objectiveId } });
  revalidatePath(revalidatePathStr);
}

// ─── Delete Key Result ────────────────────────────────────────────────────────

export async function deleteKeyResult(
  keyResultId: string,
  revalidatePathStr: string
) {
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
  const prisma = getPrisma();
  await prisma.keyResult.update({
    where: { id: keyResultId },
    data: { sortOrder },
  });
  revalidatePath(revalidatePathStr);
}
