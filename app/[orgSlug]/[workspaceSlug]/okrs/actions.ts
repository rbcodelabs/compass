"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import getPrisma from "@/lib/db";

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

  const prisma = await getPrisma();

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
  });

  if (!parsed.success) {
    throw new Error(parsed.error.issues[0].message);
  }

  const prisma = await getPrisma();

  await prisma.objective.create({
    data: {
      cycleId,
      title: parsed.data.title,
      description: parsed.data.description,
      owner: parsed.data.owner,
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

  const prisma = await getPrisma();

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

  const prisma = await getPrisma();

  // Create check-in record and update the KR's current value in one transaction.
  await prisma.$transaction([
    prisma.checkIn.create({
      data: {
        keyResultId,
        value: parsed.data.value,
        note: parsed.data.note,
      },
    }),
    prisma.keyResult.update({
      where: { id: keyResultId },
      data: { current: parsed.data.value },
    }),
  ]);

  // Revalidate both the cycle detail page (where check-in is triggered) and the
  // cycles index (where cycle cards show aggregate progress).
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

  const prisma = await getPrisma();

  await prisma.objective.update({
    where: { id: objectiveId },
    data: { status: parsed.data },
  });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/okrs`, "layout");
}
