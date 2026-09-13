"use server";

import { revalidatePath } from "next/cache";
import { isPermissionError, resolveOrgAdmin } from "@/lib/permissions";
import { findMetricConfigIssues, type MetricConfigIssue } from "@/lib/scoring";
import type { ScoringFormulaType, MetricDirection } from "@/lib/types";
import { deleteWorkspaceCascade } from "@/lib/delete-workspace-cascade";

export interface ScoringMetricInput {
  key: string;
  label: string;
  description?: string;
  minValue: number;
  maxValue: number;
  weight: number;
  direction: MetricDirection;
}

/**
 * Why every action in this file returns a result instead of throwing.
 *
 * Next replaces the message of any error thrown out of a Server Action in a
 * *production* build with the generic "An error occurred in the Server
 * Components render. …". Catching on the client cannot recover it — the text
 * is already gone by the time the rejection arrives — so a caught-and-rendered
 * `err.message` faithfully displays the mask. This surfaced as scoring-model
 * creation failing with that opaque string while the server log held the real
 * cause (`Metric "reach" must have a minValue greater than 0 …`, digest
 * 1937109697).
 *
 * The fix is transport, not validation: expected, user-caused failures are
 * returned as data. This mirrors `app/[orgSlug]/[workspaceSlug]/feedback/
 * actions.ts` (`FeedbackMutationResult`) and `components/data-grid/types.ts`
 * (`GridActionResult`), which are the established `{ ok }` convention here.
 *
 * Note this reproduces *only* against `pnpm build && pnpm start`. `next dev`
 * forwards the real message, which makes the bug look absent in dev.
 */
export type ScoringModelMutationResult =
  | { ok: true }
  | { ok: false; error: string; issues?: MetricConfigIssue[] };

export type CreateScoringModelResult =
  | { ok: true; model: { id: string; version: number } }
  | { ok: false; error: string; issues?: MetricConfigIssue[] };

export type DeleteOrganizationResult =
  | { ok: true; redirectTo: string }
  | { ok: false; error: string };

/** Prisma unique-constraint violation. */
function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Converts an *expected* failure into a result value.
 *
 * Deliberately narrow: only permission outcomes and unique-constraint
 * violations are recognised. Anything else — a dropped connection, a schema
 * drift, a bug — is **rethrown**, so a genuine fault still fails loudly, gets
 * logged by Next with a digest, and reaches error monitoring instead of being
 * flattened into a reassuring sentence the user can do nothing about. That is
 * the one case where the opaque production mask is the correct outcome.
 */
function toFailure(error: unknown): { ok: false; error: string } {
  if (isPermissionError(error)) {
    if (error.message === "Unauthorized") {
      return { ok: false, error: "You are not signed in." };
    }
    return { ok: false, error: error.message };
  }

  if (isUniqueConstraintError(error)) {
    return {
      ok: false,
      error:
        "That change collides with an existing record — metric keys must be unique within a scoring model.",
    };
  }

  throw error;
}

// ─── Scoring Models (org admin only) ──────────────────────────────────────────

export async function createScoringModel(
  orgSlug: string,
  input: {
    name: string;
    description?: string;
    formulaType: ScoringFormulaType;
    metrics: ScoringMetricInput[];
  }
): Promise<CreateScoringModelResult> {
  try {
    const { prisma, organizationId } = await resolveOrgAdmin(orgSlug);

    // Every validation runs before the first write, so a rejected submit
    // leaves nothing behind. This ordering already held for the formula rule;
    // it did *not* hold for duplicate keys, which reached the DB and tripped
    // `@@unique([scoring_model_id, key])` only after the parent ScoringModel
    // row had been created — leaving an orphan model with zero metrics.
    const issues = findMetricConfigIssues(input.metrics, input.formulaType);
    if (issues.length > 0) {
      return { ok: false, error: issues[0].message, issues };
    }

    const model = await prisma.scoringModel.create({
      data: {
        organizationId,
        name: input.name,
        description: input.description,
        formulaType: input.formulaType,
      },
    });

    if (input.metrics.length > 0) {
      await prisma.scoringModelMetric.createMany({
        data: input.metrics.map((m, i) => ({
          scoringModelId: model.id,
          key: m.key,
          label: m.label,
          description: m.description,
          minValue: m.minValue,
          maxValue: m.maxValue,
          weight: m.weight,
          direction: m.direction,
          order: i,
        })),
      });
    }

    revalidatePath(`/${orgSlug}/settings`);
    return { ok: true, model: { id: model.id, version: model.version } };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * Updates a scoring model's name/description only — does NOT bump version.
 * Per the versioning decision, only metric/formula-shape edits bump version.
 */
export async function updateScoringModelDetails(
  orgSlug: string,
  scoringModelId: string,
  input: { name?: string; description?: string }
): Promise<ScoringModelMutationResult> {
  try {
    const { prisma } = await resolveOrgAdmin(orgSlug);

    await prisma.scoringModel.update({
      where: { id: scoringModelId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        updatedAt: new Date(),
      },
    });

    revalidatePath(`/${orgSlug}/settings`);
    return { ok: true };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * Replaces a scoring model's metrics (and optionally its formula type) and
 * bumps ScoringModel.version. Existing OpportunityScore rows are untouched —
 * they carry their own formulaSnapshot and stay frozen to the version that
 * produced them until someone re-scores that opportunity.
 *
 * Full delete+recreate of the metric rows (rather than diffing) is safe
 * because OpportunityScore.formulaSnapshot is a self-contained JSON copy,
 * not a foreign key to ScoringModelMetric rows.
 */
export async function updateScoringModelMetrics(
  orgSlug: string,
  scoringModelId: string,
  input: { formulaType?: ScoringFormulaType; metrics: ScoringMetricInput[] }
): Promise<ScoringModelMutationResult> {
  try {
    const { prisma } = await resolveOrgAdmin(orgSlug);

    const existing = await prisma.scoringModel.findUnique({
      where: { id: scoringModelId },
      select: { formulaType: true, version: true },
    });
    if (!existing) return { ok: false, error: "Scoring model not found" };

    const formulaType = input.formulaType ?? (existing.formulaType as ScoringFormulaType);

    // Validate before the destructive deleteMany — otherwise a rejected edit
    // would have already wiped the model's existing metrics.
    const issues = findMetricConfigIssues(input.metrics, formulaType);
    if (issues.length > 0) {
      return { ok: false, error: issues[0].message, issues };
    }

    await prisma.scoringModelMetric.deleteMany({ where: { scoringModelId } });

    if (input.metrics.length > 0) {
      await prisma.scoringModelMetric.createMany({
        data: input.metrics.map((m, i) => ({
          scoringModelId,
          key: m.key,
          label: m.label,
          description: m.description,
          minValue: m.minValue,
          maxValue: m.maxValue,
          weight: m.weight,
          direction: m.direction,
          order: i,
        })),
      });
    }

    await prisma.scoringModel.update({
      where: { id: scoringModelId },
      data: {
        formulaType,
        version: existing.version + 1,
        updatedAt: new Date(),
      },
    });

    revalidatePath(`/${orgSlug}/settings`);
    return { ok: true };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * Archive-only "delete". ScoringModel is never hard-deleted in v1 — see
 * schema comment: OpportunityScore/WorkspaceScoringConfig rows may reference
 * it and relationMode="prisma" (DSQL, no FK cascade) means the DB won't
 * protect against orphaning them.
 */
export async function archiveScoringModel(
  orgSlug: string,
  scoringModelId: string
): Promise<ScoringModelMutationResult> {
  try {
    const { prisma } = await resolveOrgAdmin(orgSlug);

    await prisma.scoringModel.update({
      where: { id: scoringModelId },
      data: { status: "ARCHIVED", updatedAt: new Date() },
    });

    revalidatePath(`/${orgSlug}/settings`);
    return { ok: true };
  } catch (error) {
    return toFailure(error);
  }
}

// ─── Delete Organization (org OWNER/ADMIN only) ───────────────────────────────


/**
 * Permanently deletes an organization and every workspace + child row under it.
 * Owner/admin only (resolveOrgAdmin gate). Requires the caller to re-type the
 * org name as a confirmation. Returns a redirect target instead of calling
 * redirect() so the action stays unit-testable, matching deleteWorkspace.
 *
 * No prisma.$transaction: DSQL caps transaction size, and a full org purge can
 * touch far more rows than a single transaction allows — the delete is run as
 * sequential awaits, children before parents, same as deleteWorkspace.
 */
export async function deleteOrganization(
  orgSlug: string,
  confirmName: string
): Promise<DeleteOrganizationResult> {
  try {
    const { prisma, organizationId } = await resolveOrgAdmin(orgSlug);

    const organization = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true },
    });
    if (!organization) return { ok: false, error: "Organization not found" };

    if (confirmName.trim() !== organization.name) {
      return { ok: false, error: "Confirmation text does not match" };
    }

    // Delete every workspace (and its subtree) before any org-level rows —
    // Workspace.organization is Restrict, so the org can't go until they're gone.
    const workspaceIds = (
      await prisma.workspace.findMany({
        where: { organizationId },
        select: { id: true },
      })
    ).map((w) => w.id);

    for (const workspaceId of workspaceIds) {
      await deleteWorkspaceCascade(prisma, workspaceId);
    }

    // Org-level rows: scoring model metrics (Restrict) → scoring models →
    // org members → the organization itself.
    const scoringModelIds = (
      await prisma.scoringModel.findMany({
        where: { organizationId },
        select: { id: true },
      })
    ).map((m) => m.id);
    if (scoringModelIds.length > 0) {
      await prisma.scoringModelMetric.deleteMany({
        where: { scoringModelId: { in: scoringModelIds } },
      });
    }
    await prisma.scoringModel.deleteMany({ where: { organizationId } });
    await prisma.organizationMember.deleteMany({ where: { organizationId } });
    await prisma.organization.delete({ where: { id: organizationId } });

    revalidatePath("/dashboard");
    revalidatePath("/", "layout");

    return { ok: true, redirectTo: "/dashboard" };
  } catch (error) {
    return toFailure(error);
  }
}
