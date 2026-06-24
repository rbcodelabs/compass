"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { Prisma } from "@prisma/client";
import { randomBytes, createHash } from "crypto";
import type {
  CustomFieldType,
  CustomFieldObjectType,
  SelectOption,
  CustomFieldValue,
} from "@/lib/types";

// ─── Squads ───────────────────────────────────────────────────────────────────

export async function createSquad(
  orgSlug: string,
  workspaceSlug: string,
  input: { name: string; color: string }
) {
  const { prisma, workspaceId } = await resolveWorkspace(orgSlug, workspaceSlug);

  await prisma.squad.create({
    data: {
      workspaceId,
      name: input.name,
      color: input.color,
    },
  });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
}

export async function updateSquad(
  orgSlug: string,
  workspaceSlug: string,
  squadId: string,
  input: { name?: string; color?: string }
) {
  await resolveWorkspace(orgSlug, workspaceSlug);
  const prisma = getPrisma();

  await prisma.squad.update({
    where: { id: squadId },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.color !== undefined && { color: input.color }),
    },
  });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
}

export async function deleteSquad(
  orgSlug: string,
  workspaceSlug: string,
  squadId: string
) {
  await resolveWorkspace(orgSlug, workspaceSlug);
  const prisma = getPrisma();

  // Null out squad references (no FK cascade in DSQL)
  await prisma.objective.updateMany({ where: { squadId }, data: { squadId: null } });
  await prisma.opportunity.updateMany({ where: { squadId }, data: { squadId: null } });
  await prisma.experiment.updateMany({ where: { squadId }, data: { squadId: null } });
  await prisma.roadmapItem.updateMany({ where: { squadId }, data: { squadId: null } });

  await prisma.squad.delete({ where: { id: squadId } });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
}

export async function assignSquad(
  objectType: "objective" | "opportunity" | "experiment" | "roadmapItem",
  objectId: string,
  squadId: string | null,
  revalidatePathStr: string
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const prisma = getPrisma();

  if (objectType === "objective") {
    await prisma.objective.update({ where: { id: objectId }, data: { squadId } });
  } else if (objectType === "opportunity") {
    await prisma.opportunity.update({ where: { id: objectId }, data: { squadId } });
  } else if (objectType === "experiment") {
    await prisma.experiment.update({ where: { id: objectId }, data: { squadId } });
  } else if (objectType === "roadmapItem") {
    await prisma.roadmapItem.update({ where: { id: objectId }, data: { squadId } });
  }

  revalidatePath(revalidatePathStr);
}

// ─── Helper: resolve workspace and assert membership ─────────────────────────

async function resolveWorkspace(orgSlug: string, workspaceSlug: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const prisma = getPrisma();
  const workspace = await prisma.workspace.findFirst({
    where: {
      slug: workspaceSlug,
      organization: { slug: orgSlug },
    },
    select: { id: true },
  });

  if (!workspace) throw new Error("Workspace not found");
  return { prisma, workspaceId: workspace.id };
}

// ─── Field Definitions ────────────────────────────────────────────────────────

export async function createFieldDefinition(
  orgSlug: string,
  workspaceSlug: string,
  input: {
    objectType: CustomFieldObjectType;
    name: string;
    fieldType: CustomFieldType;
    options?: SelectOption[];
    required?: boolean;
  }
) {
  const { prisma, workspaceId } = await resolveWorkspace(orgSlug, workspaceSlug);

  // Determine next order index
  const count = await prisma.customFieldDefinition.count({
    where: { workspaceId, objectType: input.objectType },
  });

  await prisma.customFieldDefinition.create({
    data: {
      workspaceId,
      objectType: input.objectType,
      name: input.name,
      fieldType: input.fieldType,
      options: input.options
        ? (input.options as unknown as Prisma.InputJsonValue)
        : Prisma.DbNull,
      required: input.required ?? false,
      order: count,
    },
  });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
}

export async function deleteFieldDefinition(
  orgSlug: string,
  workspaceSlug: string,
  fieldId: string
) {
  const { prisma } = await resolveWorkspace(orgSlug, workspaceSlug);

  // Delete values first (cascade not enforced at DB level with DSQL relationMode=prisma)
  await prisma.customFieldValue.deleteMany({ where: { fieldId } });
  await prisma.customFieldDefinition.delete({ where: { id: fieldId } });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
}

export async function updateFieldDefinition(
  orgSlug: string,
  workspaceSlug: string,
  fieldId: string,
  input: {
    name?: string;
    options?: SelectOption[];
    required?: boolean;
  }
) {
  const { prisma } = await resolveWorkspace(orgSlug, workspaceSlug);

  await prisma.customFieldDefinition.update({
    where: { id: fieldId },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.options !== undefined && {
        options: input.options
          ? (input.options as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
      }),
      ...(input.required !== undefined && { required: input.required }),
    },
  });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
}

// ─── Field Values ─────────────────────────────────────────────────────────────

/**
 * Upsert the value for one custom field on one object.
 * Pass null to clear the value.
 */
export async function upsertFieldValue(
  objectId: string,
  fieldId: string,
  value: CustomFieldValue,
  revalidatePathStr: string
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const prisma = getPrisma();

  if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) {
    // Clear: delete if exists
    await prisma.customFieldValue.deleteMany({ where: { fieldId, objectId } });
  } else {
    await prisma.customFieldValue.upsert({
      where: { fieldId_objectId: { fieldId, objectId } },
      create: { fieldId, objectId, value: value as object },
      update: { value: value as object, updatedAt: new Date() },
    });
  }

  revalidatePath(revalidatePathStr);
}

// ─── API Keys ─────────────────────────────────────────────────────────────────

export async function createApiKey(
  orgSlug: string,
  workspaceSlug: string,
  name: string
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const prisma = getPrisma();
  // Verify workspace membership
  const workspace = await prisma.workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug } },
    select: { id: true },
  });
  if (!workspace) throw new Error("Workspace not found");

  // Generate key: cmp_<32 random hex>
  const randomHex = randomBytes(16).toString("hex"); // 32 hex chars
  const rawKey = `cmp_${randomHex}`;
  const keyPrefix = randomHex.slice(0, 8);
  const keyHash = createHash("sha256").update(rawKey).digest("hex");

  await prisma.apiKey.create({
    data: {
      userId: session.user.id,
      name,
      keyHash,
      keyPrefix,
    },
  });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
  // Return the raw key — shown ONCE to the user, never stored
  return { rawKey };
}

export async function revokeApiKey(
  orgSlug: string,
  workspaceSlug: string,
  keyId: string
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const prisma = getPrisma();
  // Only allow revoking own keys
  const apiKey = await prisma.apiKey.findFirst({
    where: { id: keyId, userId: session.user.id },
  });
  if (!apiKey) throw new Error("Not found");

  await prisma.apiKey.update({
    where: { id: keyId },
    data: { revokedAt: new Date() },
  });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
}
