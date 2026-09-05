"use server";

import { revalidatePath } from "next/cache";
import { resolveOrgAdmin } from "@/lib/permissions";
import { validateMetricsForFormula } from "@/lib/scoring";
import type { ScoringFormulaType, MetricDirection } from "@/lib/types";
import { getArtifactStorage } from "@/lib/artifact-storage";
import { deleteWorkspaceArtifacts } from "@/lib/artifacts";
import { deleteWorkspaceDecisionData } from "@/lib/delete-workspace-decision-data";

export interface ScoringMetricInput {
  key: string;
  label: string;
  description?: string;
  minValue: number;
  maxValue: number;
  weight: number;
  direction: MetricDirection;
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
) {
  const { prisma, organizationId } = await resolveOrgAdmin(orgSlug);

  validateMetricsForFormula(input.metrics, input.formulaType);

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
  return model;
}

/**
 * Updates a scoring model's name/description only — does NOT bump version.
 * Per the versioning decision, only metric/formula-shape edits bump version.
 */
export async function updateScoringModelDetails(
  orgSlug: string,
  scoringModelId: string,
  input: { name?: string; description?: string }
) {
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
) {
  const { prisma } = await resolveOrgAdmin(orgSlug);

  const existing = await prisma.scoringModel.findUnique({
    where: { id: scoringModelId },
    select: { formulaType: true, version: true },
  });
  if (!existing) throw new Error("Scoring model not found");

  const formulaType = input.formulaType ?? (existing.formulaType as ScoringFormulaType);
  validateMetricsForFormula(input.metrics, formulaType);

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
}

/**
 * Archive-only "delete". ScoringModel is never hard-deleted in v1 — see
 * schema comment: OpportunityScore/WorkspaceScoringConfig rows may reference
 * it and relationMode="prisma" (DSQL, no FK cascade) means the DB won't
 * protect against orphaning them.
 */
export async function archiveScoringModel(orgSlug: string, scoringModelId: string) {
  const { prisma } = await resolveOrgAdmin(orgSlug);

  await prisma.scoringModel.update({
    where: { id: scoringModelId },
    data: { status: "ARCHIVED", updatedAt: new Date() },
  });

  revalidatePath(`/${orgSlug}/settings`);
}

// ─── Delete Organization (org OWNER/ADMIN only) ───────────────────────────────

type OrgPrisma = Awaited<ReturnType<typeof resolveOrgAdmin>>["prisma"];

/**
 * Deletes a single workspace and every row that hangs off it, children before
 * parents. Aurora DSQL runs with relationMode="prisma" — no FK cascades, and
 * `onDelete: Restrict`/1:1-unique relations are EMULATED, so a Restrict
 * reference (KeyResult↔Objective, Solution←Assumption, RoadmapItem←RoadmapVote,
 * OpportunityScore, LaunchChecklist, Task↔TaskLink, etc.) will block a delete
 * unless it is broken first. Mirrors the null-then-delete precedent in
 * deleteWorkspace/deleteSquad but is deliberately complete — it also covers the
 * tables the stale deleteWorkspace misses (Task/TaskLink, Evidence,
 * OpportunityScore, WorkspaceScoringConfig, LaunchChecklist/ChecklistTemplate,
 * FeedbackAttachment, CanvasNodePosition).
 */
async function deleteWorkspaceCascade(prisma: OrgPrisma, workspaceId: string) {
  const ids = async (
    rows: Promise<{ id: string }[]>
  ): Promise<string[]> => (await rows).map((r) => r.id);

  // 1. Break the KeyResult↔Objective Restrict cycle.
  await prisma.objective.updateMany({
    where: { cycle: { workspaceId } },
    data: { parentKeyResultId: null },
  });

  // 2. Null Experiment.assumptionId so assumptions can be deleted later.
  await prisma.experiment.updateMany({
    where: { workspaceId },
    data: { assumptionId: null },
  });

  // Decision/release/capacity aggregates reference Tasks and RoadmapItems.
  // DSQL has no FK cascades, so clear the full child graph first.
  await deleteWorkspaceDecisionData(prisma, workspaceId);

  // 3. Tasks + TaskLinks (TaskLink.task is Restrict; parentTask self-ref is
  //    safe when all rows go in a single deleteMany).
  const taskIds = await ids(
    prisma.task.findMany({ where: { workspaceId }, select: { id: true } })
  );
  if (taskIds.length > 0) {
    await prisma.taskLink.deleteMany({ where: { taskId: { in: taskIds } } });
  }
  await prisma.task.deleteMany({ where: { workspaceId } });

  // 4. Launch checklists + checklist templates (all Restrict chains).
  const roadmapItemIds = await ids(
    prisma.roadmapItem.findMany({ where: { workspaceId }, select: { id: true } })
  );
  if (roadmapItemIds.length > 0) {
    const launchChecklistIds = await ids(
      prisma.launchChecklist.findMany({
        where: { roadmapItemId: { in: roadmapItemIds } },
        select: { id: true },
      })
    );
    if (launchChecklistIds.length > 0) {
      await prisma.launchChecklistItem.deleteMany({
        where: { launchChecklistId: { in: launchChecklistIds } },
      });
      await prisma.launchChecklist.deleteMany({
        where: { id: { in: launchChecklistIds } },
      });
    }
  }
  const templateIds = await ids(
    prisma.checklistTemplate.findMany({ where: { workspaceId }, select: { id: true } })
  );
  if (templateIds.length > 0) {
    await prisma.checklistTemplateItem.deleteMany({
      where: { checklistTemplateId: { in: templateIds } },
    });
  }
  await prisma.checklistTemplate.deleteMany({ where: { workspaceId } });

  // 5. Roadmap votes (Restrict) then roadmap items.
  if (roadmapItemIds.length > 0) {
    await prisma.roadmapVote.deleteMany({
      where: { roadmapItemId: { in: roadmapItemIds } },
    });
  }
  await prisma.roadmapItem.deleteMany({ where: { workspaceId } });

  // 6. Feedback votes + attachments (both Restrict) then feedback items.
  const feedbackIds = await ids(
    prisma.feedbackItem.findMany({ where: { workspaceId }, select: { id: true } })
  );
  if (feedbackIds.length > 0) {
    await prisma.feedbackVote.deleteMany({
      where: { feedbackId: { in: feedbackIds } },
    });
    await prisma.feedbackAttachment.deleteMany({
      where: { feedbackItemId: { in: feedbackIds } },
    });
  }
  await prisma.feedbackItem.deleteMany({ where: { workspaceId } });

  // 7. Custom field values (Restrict) then definitions.
  const fieldIds = await ids(
    prisma.customFieldDefinition.findMany({ where: { workspaceId }, select: { id: true } })
  );
  if (fieldIds.length > 0) {
    await prisma.customFieldValue.deleteMany({
      where: { fieldId: { in: fieldIds } },
    });
  }
  await prisma.customFieldDefinition.deleteMany({ where: { workspaceId } });

  // 8. Evidence (Restrict on workspace; SetNull toward opp/solution/assumption).
  await prisma.evidence.deleteMany({ where: { workspaceId } });

  // 9. Opportunity subtree: scores → assumptions/comments → solutions → opps.
  const opportunityIds = await ids(
    prisma.opportunity.findMany({ where: { workspaceId }, select: { id: true } })
  );
  if (opportunityIds.length > 0) {
    await prisma.opportunityScore.deleteMany({
      where: { opportunityId: { in: opportunityIds } },
    });
    const solutionIds = await ids(
      prisma.solution.findMany({
        where: { opportunityId: { in: opportunityIds } },
        select: { id: true },
      })
    );
    if (solutionIds.length > 0) {
      await prisma.assumption.deleteMany({
        where: { solutionId: { in: solutionIds } },
      });
      await prisma.solutionComment.deleteMany({
        where: { solutionId: { in: solutionIds } },
      });
      await prisma.solution.deleteMany({ where: { id: { in: solutionIds } } });
    }
  }
  await prisma.opportunity.deleteMany({ where: { workspaceId } });

  // 10. Experiment results (Restrict) then experiments.
  const experimentIds = await ids(
    prisma.experiment.findMany({ where: { workspaceId }, select: { id: true } })
  );
  if (experimentIds.length > 0) {
    await prisma.experimentResult.deleteMany({
      where: { experimentId: { in: experimentIds } },
    });
  }
  await prisma.experiment.deleteMany({ where: { workspaceId } });

  // 11. OKR subtree: check-ins → key results → objectives → cycles.
  const cycleIds = await ids(
    prisma.oKRCycle.findMany({ where: { workspaceId }, select: { id: true } })
  );
  if (cycleIds.length > 0) {
    const objectiveIds = await ids(
      prisma.objective.findMany({
        where: { cycleId: { in: cycleIds } },
        select: { id: true },
      })
    );
    if (objectiveIds.length > 0) {
      const keyResultIds = await ids(
        prisma.keyResult.findMany({
          where: { objectiveId: { in: objectiveIds } },
          select: { id: true },
        })
      );
      if (keyResultIds.length > 0) {
        await prisma.checkIn.deleteMany({
          where: { keyResultId: { in: keyResultIds } },
        });
        await prisma.keyResult.deleteMany({
          where: { id: { in: keyResultIds } },
        });
      }
      await prisma.objective.deleteMany({ where: { id: { in: objectiveIds } } });
    }
  }
  await prisma.oKRCycle.deleteMany({ where: { workspaceId } });

  // 12. Artifacts: links → current pointer → revisions → stable identity,
  // followed by best-effort private Blob cleanup.
  await deleteWorkspaceArtifacts(prisma, workspaceId, getArtifactStorage());
  await prisma.workspaceCapabilityPack.deleteMany({ where: { workspaceId } });

  // 13. Workspace-scoped singletons (both Restrict toward Workspace).
  await prisma.workspaceScoringConfig.deleteMany({ where: { workspaceId } });
  await prisma.canvasNodePosition.deleteMany({ where: { workspaceId } });

  // 14. Members + squads + docs, then the workspace itself.
  await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
  await prisma.squad.deleteMany({ where: { workspaceId } });
  await prisma.doc.deleteMany({ where: { workspaceId } });
  await prisma.workspace.delete({ where: { id: workspaceId } });
}

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
): Promise<{ redirectTo: string }> {
  const { prisma, organizationId } = await resolveOrgAdmin(orgSlug);

  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { name: true },
  });
  if (!organization) throw new Error("Organization not found");

  if (confirmName.trim() !== organization.name) {
    throw new Error("Confirmation text does not match");
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

  return { redirectTo: "/dashboard" };
}
