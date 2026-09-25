"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { Prisma } from "@prisma/client";
import { randomBytes, createHash } from "crypto";
import { isPermissionError, resolveWorkspaceAdmin } from "@/lib/permissions";
import { countWorkspaceAdmins, normalizeWorkspaceRole } from "@/lib/roles";
import { PRESET_PALETTES, PRESET_FONTS } from "@/lib/branding-presets";
import { encrypt } from "@/lib/crypto-secrets";
import { generateSsoSecret } from "@/lib/portal-sso";
import { getArtifactStorage } from "@/lib/artifact-storage";
import { deleteWorkspaceArtifacts } from "@/lib/artifacts";
import { deleteWorkspaceDecisionData } from "@/lib/delete-workspace-decision-data";
import { deleteWorkspaceAnalytics } from "@/lib/analytics/service";
import { deleteWorkspaceResearchData } from "@/lib/research-workspace-cleanup";
import { deleteWorkspaceCapabilityPacks } from "@/lib/capability-pack-cleanup";
import { revokeMemberAgentGrants, deleteWorkspaceAgentData } from "@/lib/agent-lifecycle";
import { deleteWorkspaceUpdates } from "@/lib/workspace-updates-cleanup";
import {
  normalizeSelectOptions,
  parseSelectOptions,
  supportsSharedOptionSet,
  type SelectOptionInput,
} from "@/lib/shared-field-options";
import type {
  CustomFieldType,
  CustomFieldObjectType,
  CustomFieldValue,
  WorkspaceRole,
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
  await prisma.roadmapItem.updateMany({ where: { squadId }, data: { squadId: null, updatedAt: new Date() } });

  await prisma.squad.delete({ where: { id: squadId } });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
}

export async function assignSquad(
  objectType: "objective" | "opportunity" | "experiment" | "roadmapItem" | "task",
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
    await prisma.roadmapItem.update({ where: { id: objectId }, data: { squadId, updatedAt: new Date() } });
  } else if (objectType === "task") {
    await prisma.task.update({ where: { id: objectId }, data: { squadId, updatedAt: new Date() } });
  }

  revalidatePath(revalidatePathStr);
}

// ─── Helper: resolve workspace and assert membership ─────────────────────────

async function resolveWorkspace(orgSlug: string, workspaceSlug: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const prisma = getPrisma();
  // Scope the lookup to workspaces the caller is actually a member of — a
  // non-member hitting a valid org/workspace slug pair must not be able to
  // read or mutate settings just because the workspace exists. Matches the
  // membership-scoping pattern used by getWorkspace() in lib/workspace.ts.
  const workspace = await prisma.workspace.findFirst({
    where: {
      slug: workspaceSlug,
      organization: { slug: orgSlug },
      members: { some: { userId: session.user.id } },
    },
    select: { id: true, organizationId: true },
  });

  if (!workspace) throw new Error("Workspace not found");
  return { prisma, workspaceId: workspace.id, organizationId: workspace.organizationId };
}

// ─── Workspace Members ─────────────────────────────────────────────────────────

export async function addWorkspaceMember(
  orgSlug: string,
  workspaceSlug: string,
  input: { email: string; role: WorkspaceRole }
) {
  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new Error("A valid email address is required");
  }

  const { prisma, workspaceId, organizationId } = await resolveWorkspaceAdmin(orgSlug, workspaceSlug);

  // Bare upsert — invited users may not have signed in before. Mirrors the
  // dev-auth upsert pattern in auth.ts; no name/emailVerified needed here,
  // they'll be filled in when the invitee actually signs in.
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email },
  });

  const existingOrgMember = await prisma.organizationMember.findFirst({
    where: { organizationId, userId: user.id },
  });
  if (!existingOrgMember) {
    await prisma.organizationMember.create({
      data: { organizationId, userId: user.id, role: "MEMBER" },
    });
  }

  const existingWorkspaceMember = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId: user.id },
  });
  if (existingWorkspaceMember) {
    throw new Error("User is already a member of this workspace");
  }

  await prisma.workspaceMember.create({
    data: { workspaceId, userId: user.id, role: normalizeWorkspaceRole(input.role) },
  });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
}

export async function updateWorkspaceMemberRole(
  orgSlug: string,
  workspaceSlug: string,
  memberId: string,
  role: WorkspaceRole
) {
  const { prisma, workspaceId } = await resolveWorkspaceAdmin(orgSlug, workspaceSlug);

  // Scope to this workspace so a memberId from another workspace can't be touched.
  const member = await prisma.workspaceMember.findFirst({
    where: { id: memberId, workspaceId },
  });
  if (!member) throw new Error("Member not found");

  if (normalizeWorkspaceRole(member.role) === "ADMIN" && role !== "ADMIN") {
    // Counted in application code through normalizeWorkspaceRole rather than
    // with an exact SQL match on "ADMIN": a legacy row stored as "OWNER" is a
    // real admin, and an exact match would miss it and let the last one go.
    const roles = await prisma.workspaceMember.findMany({
      where: { workspaceId },
      select: { role: true },
    });
    if (countWorkspaceAdmins(roles.map((r) => r.role)) <= 1) {
      throw new Error("Cannot demote the last remaining admin — promote another member first");
    }
  }

  await prisma.workspaceMember.update({
    where: { id: memberId },
    data: { role: normalizeWorkspaceRole(role) },
  });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
}

export async function removeWorkspaceMember(
  orgSlug: string,
  workspaceSlug: string,
  memberId: string
) {
  const { prisma, workspaceId } = await resolveWorkspaceAdmin(orgSlug, workspaceSlug);

  // Scope to this workspace so a memberId from another workspace can't be touched.
  const member = await prisma.workspaceMember.findFirst({
    where: { id: memberId, workspaceId },
  });
  if (!member) throw new Error("Member not found");

  const totalCount = await prisma.workspaceMember.count({ where: { workspaceId } });
  if (totalCount <= 1) {
    throw new Error("Cannot remove the last member of a workspace");
  }

  if (normalizeWorkspaceRole(member.role) === "ADMIN") {
    // Same normalization reasoning as the demotion guard above.
    const roles = await prisma.workspaceMember.findMany({
      where: { workspaceId },
      select: { role: true },
    });
    if (countWorkspaceAdmins(roles.map((r) => r.role)) <= 1) {
      throw new Error("Cannot remove the last remaining admin — promote another member first");
    }
  }

  await prisma.$transaction(async (tx) => {
    // Lock before reading grants: PostgreSQL READ COMMITTED must see grants
    // committed by an earlier holder of this row lock before revoking them.
    // DSQL also detects the shared write as a grant/removal conflict.
    // A stale role must not overwrite a concurrent promotion or demotion.
    const locked = await tx.workspaceMember.updateMany({ where: { id: memberId, role: member.role }, data: { role: member.role } });
    if (locked.count !== 1) throw new Error("Membership changed; retry the operation");
    await revokeMemberAgentGrants(tx, workspaceId, member.userId);
    await tx.workspaceMember.delete({ where: { id: memberId } });
  });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
}

// ─── Shared Field Option Sets ─────────────────────────────────────────────────

/**
 * Loads a shared option set and proves it belongs to this workspace. There is
 * no database-level FK (relationMode = "prisma" on DSQL), so every reference to
 * a set id from a request has to be validated here or a caller could point a
 * field at another workspace's picklist.
 */
async function requireSharedOptionSet(
  prisma: ReturnType<typeof getPrisma>,
  workspaceId: string,
  setId: string
) {
  const set = await prisma.sharedFieldOptionSet.findFirst({
    where: { id: setId, workspaceId },
    select: { id: true, name: true, options: true },
  });
  if (!set) throw new Error("Shared option set not found");
  return set;
}

export async function createSharedFieldOptionSet(
  orgSlug: string,
  workspaceSlug: string,
  input: { name: string; options: SelectOptionInput[] }
) {
  const session = await auth();
  const { prisma, workspaceId } = await resolveWorkspace(orgSlug, workspaceSlug);

  const name = input.name.trim();
  if (!name) throw new Error("A name is required for a shared option set");

  await prisma.sharedFieldOptionSet.create({
    data: {
      workspaceId,
      name,
      options: normalizeSelectOptions(input.options) as unknown as Prisma.InputJsonValue,
      createdById: session?.user?.id ?? null,
      updatedById: session?.user?.id ?? null,
      source: "UI",
      // No @updatedAt on DSQL — stamped explicitly on every write.
      updatedAt: new Date(),
    },
  });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
}

export async function updateSharedFieldOptionSet(
  orgSlug: string,
  workspaceSlug: string,
  setId: string,
  input: { name?: string; options?: SelectOptionInput[] }
) {
  const session = await auth();
  const { prisma, workspaceId } = await resolveWorkspace(orgSlug, workspaceSlug);
  await requireSharedOptionSet(prisma, workspaceId, setId);

  const name = input.name?.trim();
  if (input.name !== undefined && !name) {
    throw new Error("A name is required for a shared option set");
  }

  await prisma.sharedFieldOptionSet.update({
    where: { id: setId },
    data: {
      ...(name !== undefined && { name }),
      ...(input.options !== undefined && {
        options: normalizeSelectOptions(input.options) as unknown as Prisma.InputJsonValue,
      }),
      updatedById: session?.user?.id ?? null,
      updatedAt: new Date(),
    },
  });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
}

export type DeleteSharedFieldOptionSetResult = { ok: true } | { ok: false; error: string };

/**
 * Deleting a set that fields still point at is blocked outright rather than
 * cascading sharedOptionSetId to NULL. A cascade would silently leave those
 * fields with an empty picklist while their stored CustomFieldValues still
 * referenced options nobody can see any more; an explicit detach (which copies
 * the options down first) is the only supported way to break the link.
 *
 * "Still referenced" is an expected outcome, so it comes back as a value rather
 * than a thrown Error: Next.js replaces a thrown server-action message with a
 * generic "An error occurred in the Server Components render" in production
 * builds, which would strip exactly the field count this guard exists to show.
 * Genuine faults (a set outside this workspace) still throw.
 */
export async function deleteSharedFieldOptionSet(
  orgSlug: string,
  workspaceSlug: string,
  setId: string
): Promise<DeleteSharedFieldOptionSetResult> {
  const { prisma, workspaceId } = await resolveWorkspace(orgSlug, workspaceSlug);
  await requireSharedOptionSet(prisma, workspaceId, setId);

  const references = await prisma.customFieldDefinition.count({
    where: { workspaceId, sharedOptionSetId: setId },
  });
  if (references > 0) {
    return {
      ok: false,
      error:
        references === 1
          ? "1 field uses this — detach it first"
          : `${references} fields use this — detach them first`,
    };
  }

  await prisma.sharedFieldOptionSet.delete({ where: { id: setId } });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
  return { ok: true };
}

// ─── Field Definitions ────────────────────────────────────────────────────────

export async function createFieldDefinition(
  orgSlug: string,
  workspaceSlug: string,
  input: {
    objectType: CustomFieldObjectType;
    name: string;
    fieldType: CustomFieldType;
    options?: SelectOptionInput[];
    required?: boolean;
    sharedOptionSetId?: string | null;
  }
) {
  const { prisma, workspaceId } = await resolveWorkspace(orgSlug, workspaceSlug);

  if (input.sharedOptionSetId) {
    if (!supportsSharedOptionSet(input.fieldType)) {
      throw new Error("Only a SELECT or MULTI_SELECT field can use a shared option set");
    }
    await requireSharedOptionSet(prisma, workspaceId, input.sharedOptionSetId);
  }

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
      // A field never holds both a local list and a shared link — the shared
      // set is the single source of truth once attached.
      options: input.sharedOptionSetId
        ? Prisma.DbNull
        : input.options
          ? (normalizeSelectOptions(input.options) as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
      sharedOptionSetId: input.sharedOptionSetId ?? null,
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
    options?: SelectOptionInput[];
    required?: boolean;
    /** Pass a set id to attach, `null` to detach, omit to leave the link alone. */
    sharedOptionSetId?: string | null;
  }
) {
  const { prisma, workspaceId } = await resolveWorkspace(orgSlug, workspaceSlug);

  let linkData: Prisma.CustomFieldDefinitionUpdateInput | Record<string, unknown> = {};
  if (input.sharedOptionSetId !== undefined) {
    const field = await prisma.customFieldDefinition.findFirst({
      where: { id: fieldId, workspaceId },
      include: { sharedOptionSet: { select: { id: true, name: true, options: true } } },
    });
    if (!field) throw new Error("Field not found");

    if (input.sharedOptionSetId) {
      if (!supportsSharedOptionSet(field.fieldType)) {
        throw new Error("Only a SELECT or MULTI_SELECT field can use a shared option set");
      }
      await requireSharedOptionSet(prisma, workspaceId, input.sharedOptionSetId);
      // Attaching discards the stale local copy so the two can never disagree.
      linkData = { sharedOptionSetId: input.sharedOptionSetId, options: Prisma.DbNull };
    } else {
      // Detaching copies the set's *current* options down as this field's new
      // local list. Never reset to empty: the stored CustomFieldValues hold
      // option value strings, and wiping the list would orphan every tag.
      linkData = {
        sharedOptionSetId: null,
        options: parseSelectOptions(
          field.sharedOptionSet?.options
        ) as unknown as Prisma.InputJsonValue,
      };
    }
  }

  await prisma.customFieldDefinition.update({
    where: { id: fieldId },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.options !== undefined && {
        options: input.options
          ? (normalizeSelectOptions(input.options) as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
      }),
      ...(input.required !== undefined && { required: input.required }),
      ...linkData,
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

  const createdKey = await prisma.apiKey.create({
    data: {
      userId: session.user.id,
      name,
      keyHash,
      keyPrefix,
    },
  });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
  // Return the raw key — shown ONCE to the user, never stored
  return { id: createdKey.id, rawKey };
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

// ─── Delete Workspace ─────────────────────────────────────────────────────────

/**
 * Permanently deletes a workspace and all its data.
 *
 * Aurora DSQL does not enforce FK cascades, so we must delete child records
 * before parents, in dependency order. Returns the path to redirect to after
 * deletion (another workspace in the org, or "/" if the org is also deleted).
 */
export async function deleteWorkspace(
  orgSlug: string,
  workspaceSlug: string
): Promise<{ redirectTo: string }> {
  const { prisma, workspaceId, organizationId } = await resolveWorkspaceAdmin(orgSlug, workspaceSlug);

  // Decision/release/capacity aggregates reference Tasks and RoadmapItems.
  // DSQL has no FK cascades, so clear the full child graph first.
  await deleteWorkspaceDecisionData(prisma, workspaceId);
  await deleteWorkspaceResearchData(prisma, workspaceId);

  // ── Step 1: Break the Objective <-> KeyResult circular reference ────────────
  // Objective.parentKeyResultId references KeyResult; null it before deleting KRs.
  await prisma.objective.updateMany({
    where: { cycle: { workspaceId } },
    data: { parentKeyResultId: null },
  });

  // ── Step 2: Delete RoadmapVotes (child of RoadmapItem) ─────────────────────
  const roadmapItemIds = await prisma.roadmapItem
    .findMany({ where: { workspaceId }, select: { id: true } })
    .then((items) => items.map((i) => i.id));

  if (roadmapItemIds.length > 0) {
    await prisma.roadmapVote.deleteMany({
      where: { roadmapItemId: { in: roadmapItemIds } },
    });
  }

  // ── Step 3: Delete RoadmapItems ─────────────────────────────────────────────
  await prisma.roadmapItem.deleteMany({ where: { workspaceId } });

  // ── Step 4: Delete CheckIns (child of KeyResult, via Objective -> OKRCycle) ─
  const cycleIds = await prisma.oKRCycle
    .findMany({ where: { workspaceId }, select: { id: true } })
    .then((c) => c.map((x) => x.id));

  if (cycleIds.length > 0) {
    const objectiveIds = await prisma.objective
      .findMany({ where: { cycleId: { in: cycleIds } }, select: { id: true } })
      .then((o) => o.map((x) => x.id));

    if (objectiveIds.length > 0) {
      const keyResultIds = await prisma.keyResult
        .findMany({ where: { objectiveId: { in: objectiveIds } }, select: { id: true } })
        .then((kr) => kr.map((x) => x.id));

      if (keyResultIds.length > 0) {
        await prisma.checkIn.deleteMany({
          where: { keyResultId: { in: keyResultIds } },
        });
      }
    }
  }

  // ── Step 5: Delete ExperimentResults (child of Experiment) ──────────────────
  const experimentIds = await prisma.experiment
    .findMany({ where: { workspaceId }, select: { id: true } })
    .then((e) => e.map((x) => x.id));

  if (experimentIds.length > 0) {
    await prisma.experimentResult.deleteMany({
      where: { experimentId: { in: experimentIds } },
    });
  }

  // ── Step 6: Delete FeedbackVotes (child of FeedbackItem) ────────────────────
  const feedbackIds = await prisma.feedbackItem
    .findMany({ where: { workspaceId }, select: { id: true } })
    .then((f) => f.map((x) => x.id));

  if (feedbackIds.length > 0) {
    await prisma.feedbackVote.deleteMany({
      where: { feedbackId: { in: feedbackIds } },
    });
  }

  // ── Step 7: Delete FeedbackItems ────────────────────────────────────────────
  await prisma.feedbackItem.deleteMany({ where: { workspaceId } });

  // ── Step 8: Delete CustomFieldValues + CustomFieldDefinitions ───────────────
  const fieldIds = await prisma.customFieldDefinition
    .findMany({ where: { workspaceId }, select: { id: true } })
    .then((f) => f.map((x) => x.id));

  if (fieldIds.length > 0) {
    await prisma.customFieldValue.deleteMany({
      where: { fieldId: { in: fieldIds } },
    });
  }
  await prisma.customFieldDefinition.deleteMany({ where: { workspaceId } });
  // Shared option sets can only go once nothing references them any more.
  await prisma.sharedFieldOptionSet.deleteMany({ where: { workspaceId } });

  // ── Step 9: Null Experiment.assumptionId before deleting Assumptions ─────────
  if (experimentIds.length > 0) {
    await prisma.experiment.updateMany({
      where: { id: { in: experimentIds } },
      data: { assumptionId: null },
    });
  }

  // ── Step 10: Delete Assumptions (child of Solution -> Opportunity) ───────────
  const opportunityIds = await prisma.opportunity
    .findMany({ where: { workspaceId }, select: { id: true } })
    .then((o) => o.map((x) => x.id));

  if (opportunityIds.length > 0) {
    const solutionIds = await prisma.solution
      .findMany({ where: { opportunityId: { in: opportunityIds } }, select: { id: true } })
      .then((s) => s.map((x) => x.id));

    if (solutionIds.length > 0) {
      await prisma.assumption.deleteMany({
        where: { solutionId: { in: solutionIds } },
      });
      // SolutionComment has no cascade delete (relationMode = "prisma"), so
      // it must be cleared before the Solution rows themselves are deleted,
      // same reasoning as the Assumption deleteMany above.
      await prisma.solutionComment.deleteMany({
        where: { solutionId: { in: solutionIds } },
      });
      // ── Step 11: Delete Solutions ───────────────────────────────────────────
      await prisma.solution.deleteMany({
        where: { id: { in: solutionIds } },
      });
    }
  }

  // ── Step 12: Delete Opportunities ───────────────────────────────────────────
  await prisma.opportunity.deleteMany({ where: { workspaceId } });

  // ── Step 13: Delete Experiments ─────────────────────────────────────────────
  await prisma.experiment.deleteMany({ where: { workspaceId } });

  // ── Step 14: Delete KeyResults then Objectives then OKRCycles ───────────────
  if (cycleIds.length > 0) {
    const objectiveIds = await prisma.objective
      .findMany({ where: { cycleId: { in: cycleIds } }, select: { id: true } })
      .then((o) => o.map((x) => x.id));

    if (objectiveIds.length > 0) {
      await prisma.keyResult.deleteMany({
        where: { objectiveId: { in: objectiveIds } },
      });
      await prisma.objective.deleteMany({
        where: { id: { in: objectiveIds } },
      });
    }
    await prisma.oKRCycle.deleteMany({ where: { workspaceId } });
  }

  // ── Step 15: Delete Artifacts and private blobs ─────────────────────────────
  await deleteWorkspaceArtifacts(prisma, workspaceId, getArtifactStorage());
  await deleteWorkspaceCapabilityPacks(prisma, workspaceId);
  await deleteWorkspaceAgentData(prisma, workspaceId);
  await deleteWorkspaceUpdates(prisma, workspaceId);

  // ── Step 16: Delete WorkspaceMembers ────────────────────────────────────────
  await prisma.workspaceMember.deleteMany({ where: { workspaceId } });

  // ── Step 17: Delete Squads ──────────────────────────────────────────────────
  await prisma.squad.deleteMany({ where: { workspaceId } });

  // ── Step 18: Delete Docs (self-referential; no DB FK so deleteMany is safe) ─
  await prisma.doc.deleteMany({ where: { workspaceId } });

  // ── Step 19: Delete the Workspace itself ────────────────────────────────────
  await prisma.$transaction(async tx => {
    await tx.workspace.delete({ where: { id: workspaceId } });
    await deleteWorkspaceAnalytics(tx, workspaceId);
  });

  // ── Step 20: If the org has no remaining workspaces, delete it too ───────────
  const remainingWorkspaces = await prisma.workspace.findMany({
    where: { organizationId },
    select: { id: true, slug: true },
  });

  if (remainingWorkspaces.length === 0) {
    // Delete org members then the org itself
    await prisma.organizationMember.deleteMany({ where: { organizationId } });
    await prisma.organization.delete({ where: { id: organizationId } });
    return { redirectTo: "/" };
  }

  // Redirect to the first remaining workspace
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { slug: true },
  });

  const nextWorkspace = remainingWorkspaces[0];
  return { redirectTo: `/${org?.slug ?? orgSlug}/${nextWorkspace.slug}` };
}

// ─── Scoring (workspace admin only) ────────────────────────────────────────────

/**
 * Sets (or clears, with scoringModelId=null) the workspace's active scoring
 * model. Any member can subsequently input opportunity scores against it
 * (see the Opportunity ScoringPanel's saveOpportunityScore action, gated by
 * the plain resolveWorkspace membership check) — only *picking* the model
 * is admin-gated, per the brainstorm decision.
 */
/**
 * Returns a result rather than throwing, for the same transport reason as the
 * org-level scoring actions — see the header comment in
 * `app/[orgSlug]/settings/actions.ts`. Its only expected failure is a
 * permission outcome; a genuine fault is rethrown by `toScoringFailure`.
 */
export type SetActiveScoringModelResult = { ok: true } | { ok: false; error: string };

function toScoringFailure(error: unknown): { ok: false; error: string } {
  if (isPermissionError(error)) {
    return {
      ok: false,
      error: error.message === "Unauthorized" ? "You are not signed in." : error.message,
    };
  }
  throw error;
}

export async function setActiveScoringModel(
  orgSlug: string,
  workspaceSlug: string,
  scoringModelId: string | null
): Promise<SetActiveScoringModelResult> {
  try {
    const { prisma, workspaceId } = await resolveWorkspaceAdmin(orgSlug, workspaceSlug);

    await prisma.workspaceScoringConfig.upsert({
      where: { workspaceId },
      create: { workspaceId, scoringModelId },
      update: { scoringModelId, updatedAt: new Date() },
    });

    revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
    return { ok: true };
  } catch (error) {
    return toScoringFailure(error);
  }
}

// ─── Portal Settings ──────────────────────────────────────────────────────────

export async function updatePortalSettings(
  orgSlug: string,
  workspaceSlug: string,
  input: {
    feedbackEnabled?: boolean;
    roadmapPublic?: boolean;
    portalAuthRequired?: boolean;
    ssoEnabled?: boolean;
  }
) {
  const { prisma, workspaceId } = await resolveWorkspace(orgSlug, workspaceSlug);

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      ...(input.feedbackEnabled !== undefined && { feedbackEnabled: input.feedbackEnabled }),
      ...(input.roadmapPublic !== undefined && { roadmapPublic: input.roadmapPublic }),
      ...(input.portalAuthRequired !== undefined && { portalAuthRequired: input.portalAuthRequired }),
      ...(input.ssoEnabled !== undefined && { ssoEnabled: input.ssoEnabled }),
    },
  });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
}

/**
 * Generates a brand-new SSO shared secret, encrypts it at rest, and
 * overwrites whatever secret (if any) the workspace had before — there is
 * no rotation grace window in v1 (documented limitation). Returns the raw
 * secret exactly once; it is never stored or returned again after this
 * call returns, mirroring the ApiKey / createApiKey precedent above.
 */
export async function regenerateSsoSecret(
  orgSlug: string,
  workspaceSlug: string
): Promise<{ rawSecret: string }> {
  const { prisma, workspaceId } = await resolveWorkspace(orgSlug, workspaceSlug);

  const encryptionKey = process.env.SSO_SECRET_ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error("SSO_SECRET_ENCRYPTION_KEY is not configured on the server");
  }

  const rawSecret = generateSsoSecret();
  const ssoSecretEncrypted = encrypt(rawSecret, encryptionKey);

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      ssoSecretEncrypted,
      ssoSecretUpdatedAt: new Date(),
    },
  });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);

  return { rawSecret };
}

// ─── Workspace Branding ───────────────────────────────────────────────────────

const BRANDING_HEX_RE = /^#[0-9a-fA-F]{6}$/;
// Blocks CSS/HTML injection characters (`;`, `{`, `}`, `<`, `>`, `"`, backtick, `'`)
// since fontFamily is interpolated directly into a raw <style> string and a
// Google Fonts URL — this validation is a security boundary, not just UX.
const BRANDING_FONT_FAMILY_RE = /^[A-Za-z0-9 '-]{1,60}$/;

/**
 * Updates a workspace's branding (color palette/custom hex, font preset/custom
 * family, logo). `primaryHex` and `fontFamily` are eventually interpolated into
 * a raw `dangerouslySetInnerHTML` <style> string and a font-loading URL by
 * WorkspaceThemeStyle, so the validation below is load-bearing for security,
 * not just data hygiene — reject the whole call on any bad field rather than
 * silently dropping it and saving the rest.
 */
export async function updateWorkspaceBranding(
  orgSlug: string,
  workspaceSlug: string,
  input: {
    paletteId?: string | null;
    primaryHex?: string | null;
    fontPresetId?: string | null;
    fontFamily?: string | null;
    logoUrl?: string | null;
  }
) {
  const { prisma, workspaceId } = await resolveWorkspace(orgSlug, workspaceSlug);

  if (
    input.primaryHex !== undefined &&
    input.primaryHex !== null &&
    !BRANDING_HEX_RE.test(input.primaryHex)
  ) {
    throw new Error("Invalid primaryHex — must be a 6-digit hex color like #4f3df2");
  }

  if (
    input.fontFamily !== undefined &&
    input.fontFamily !== null &&
    !BRANDING_FONT_FAMILY_RE.test(input.fontFamily)
  ) {
    throw new Error(
      "Invalid fontFamily — only letters, numbers, spaces, hyphens, and apostrophes are allowed (max 60 chars)"
    );
  }

  if (
    input.paletteId !== undefined &&
    input.paletteId !== null &&
    !PRESET_PALETTES.some((p) => p.id === input.paletteId)
  ) {
    throw new Error(`Unknown paletteId: ${input.paletteId}`);
  }

  if (
    input.fontPresetId !== undefined &&
    input.fontPresetId !== null &&
    !PRESET_FONTS.some((f) => f.id === input.fontPresetId)
  ) {
    throw new Error(`Unknown fontPresetId: ${input.fontPresetId}`);
  }

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      ...(input.paletteId !== undefined && { brandingPaletteId: input.paletteId }),
      ...(input.primaryHex !== undefined && { brandingPrimaryHex: input.primaryHex }),
      ...(input.fontPresetId !== undefined && { brandingFontPresetId: input.fontPresetId }),
      ...(input.fontFamily !== undefined && { brandingFontFamily: input.fontFamily }),
      ...(input.logoUrl !== undefined && { brandingLogoUrl: input.logoUrl }),
      updatedAt: new Date(),
    },
  });

  // Branding renders in the settings page AND both authenticated workspace +
  // public portal layouts — all three revalidations matter.
  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
  revalidatePath(`/${orgSlug}/${workspaceSlug}`, "layout");
  revalidatePath(`/portal/${orgSlug}/${workspaceSlug}`, "layout");
}

// ─── Roadmap WIP Limits ────────────────────────────────────────────────────────

/**
 * Updates the workspace's NOW/NEXT roadmap WIP limits. `undefined` leaves a
 * field untouched; explicit `null` clears it back to "no limit". Purely
 * advisory display settings — see docs/decisions/0005 and 0006 (both
 * Superseded) for why this must never grow into enforcement.
 */
export async function updateWorkspaceLimits(
  orgSlug: string,
  workspaceSlug: string,
  input: {
    nowLimit?: number | null;
    nextLimit?: number | null;
  }
) {
  const { prisma, workspaceId } = await resolveWorkspace(orgSlug, workspaceSlug);

  for (const [field, value] of Object.entries(input) as [keyof typeof input, number | null | undefined][]) {
    if (value !== undefined && value !== null && (!Number.isInteger(value) || value < 0)) {
      throw new Error(`Invalid ${field} — must be a non-negative whole number or empty`);
    }
  }

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      ...(input.nowLimit !== undefined && { nowLimit: input.nowLimit }),
      ...(input.nextLimit !== undefined && { nextLimit: input.nextLimit }),
    },
  });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
  revalidatePath(`/${orgSlug}/${workspaceSlug}/roadmap`);
}

// ─── Marketing launch workflow ─────────────────────────────────────────────────

/**
 * Toggles the workspace-level marketing-launch surface (launch tiers,
 * checklists, LAUNCHING/LAUNCHED roadmap horizons, positioning briefs, and
 * the related MCP tools). Default off; see prisma/schema.prisma comment on
 * Workspace.launchWorkflowEnabled and Compass solution 8303c3df-498d-4503-
 * b92b-c7fd7a0fa62d for the product rationale. Revalidates both settings and
 * roadmap so the board reflects the change without a hard refresh.
 */
export async function updateLaunchWorkflowSettings(
  orgSlug: string,
  workspaceSlug: string,
  input: { launchWorkflowEnabled: boolean }
) {
  const { prisma, workspaceId } = await resolveWorkspace(orgSlug, workspaceSlug);

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { launchWorkflowEnabled: input.launchWorkflowEnabled },
  });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
  revalidatePath(`/${orgSlug}/${workspaceSlug}/roadmap`);
}
