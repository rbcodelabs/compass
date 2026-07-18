"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { Prisma } from "@prisma/client";
import { randomBytes, createHash } from "crypto";
import { resolveWorkspaceAdmin } from "@/lib/permissions";
import { PRESET_PALETTES, PRESET_FONTS } from "@/lib/branding-presets";
import type {
  CustomFieldType,
  CustomFieldObjectType,
  SelectOption,
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

  const { prisma, workspaceId, organizationId } = await resolveWorkspace(orgSlug, workspaceSlug);

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
    data: { workspaceId, userId: user.id, role: input.role },
  });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
}

export async function updateWorkspaceMemberRole(
  orgSlug: string,
  workspaceSlug: string,
  memberId: string,
  role: WorkspaceRole
) {
  const { prisma, workspaceId } = await resolveWorkspace(orgSlug, workspaceSlug);

  // Scope to this workspace so a memberId from another workspace can't be touched.
  const member = await prisma.workspaceMember.findFirst({
    where: { id: memberId, workspaceId },
  });
  if (!member) throw new Error("Member not found");

  if (member.role === "ADMIN" && role !== "ADMIN") {
    const adminCount = await prisma.workspaceMember.count({
      where: { workspaceId, role: "ADMIN" },
    });
    if (adminCount <= 1) {
      throw new Error("Cannot demote the last remaining admin — promote another member first");
    }
  }

  await prisma.workspaceMember.update({
    where: { id: memberId },
    data: { role },
  });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
}

export async function removeWorkspaceMember(
  orgSlug: string,
  workspaceSlug: string,
  memberId: string
) {
  const { prisma, workspaceId } = await resolveWorkspace(orgSlug, workspaceSlug);

  // Scope to this workspace so a memberId from another workspace can't be touched.
  const member = await prisma.workspaceMember.findFirst({
    where: { id: memberId, workspaceId },
  });
  if (!member) throw new Error("Member not found");

  const totalCount = await prisma.workspaceMember.count({ where: { workspaceId } });
  if (totalCount <= 1) {
    throw new Error("Cannot remove the last member of a workspace");
  }

  if (member.role === "ADMIN") {
    const adminCount = await prisma.workspaceMember.count({
      where: { workspaceId, role: "ADMIN" },
    });
    if (adminCount <= 1) {
      throw new Error("Cannot remove the last remaining admin — promote another member first");
    }
  }

  await prisma.workspaceMember.delete({ where: { id: memberId } });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
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
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const prisma = getPrisma();

  const workspace = await prisma.workspace.findFirst({
    where: {
      slug: workspaceSlug,
      organization: { slug: orgSlug },
    },
    select: { id: true, organizationId: true },
  });

  if (!workspace) throw new Error("Workspace not found");

  const workspaceId = workspace.id;
  const organizationId = workspace.organizationId;

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

  // ── Step 15: Delete WorkspaceMembers ────────────────────────────────────────
  await prisma.workspaceMember.deleteMany({ where: { workspaceId } });

  // ── Step 16: Delete Squads ──────────────────────────────────────────────────
  await prisma.squad.deleteMany({ where: { workspaceId } });

  // ── Step 17: Delete Docs (self-referential; no DB FK so deleteMany is safe) ─
  await prisma.doc.deleteMany({ where: { workspaceId } });

  // ── Step 18: Delete the Workspace itself ────────────────────────────────────
  await prisma.workspace.delete({ where: { id: workspaceId } });

  // ── Step 19: If the org has no remaining workspaces, delete it too ───────────
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
export async function setActiveScoringModel(
  orgSlug: string,
  workspaceSlug: string,
  scoringModelId: string | null
) {
  const { prisma, workspaceId } = await resolveWorkspaceAdmin(orgSlug, workspaceSlug);

  await prisma.workspaceScoringConfig.upsert({
    where: { workspaceId },
    create: { workspaceId, scoringModelId },
    update: { scoringModelId, updatedAt: new Date() },
  });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
}

// ─── Portal Settings ──────────────────────────────────────────────────────────

export async function updatePortalSettings(
  orgSlug: string,
  workspaceSlug: string,
  input: { feedbackEnabled?: boolean; roadmapPublic?: boolean; portalAuthRequired?: boolean }
) {
  const { prisma, workspaceId } = await resolveWorkspace(orgSlug, workspaceSlug);

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      ...(input.feedbackEnabled !== undefined && { feedbackEnabled: input.feedbackEnabled }),
      ...(input.roadmapPublic !== undefined && { roadmapPublic: input.roadmapPublic }),
      ...(input.portalAuthRequired !== undefined && { portalAuthRequired: input.portalAuthRequired }),
    },
  });

  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
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
