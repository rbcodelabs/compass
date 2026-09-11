import type { PrismaClient } from "@prisma/client";
import { getArtifactStorage } from "@/lib/artifact-storage";
import { deleteWorkspaceArtifacts } from "@/lib/artifacts";
import { deleteWorkspaceDecisionData } from "@/lib/delete-workspace-decision-data";
import { deleteWorkspaceCapabilityPacks } from "@/lib/capability-pack-cleanup";
import { deleteWorkspaceAgentData } from "@/lib/agent-lifecycle";

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
export async function deleteWorkspaceCascade(prisma: PrismaClient, workspaceId: string, options: { skipBlobCleanup?: boolean } = {}) {
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
  await deleteWorkspaceArtifacts(prisma, workspaceId, getArtifactStorage(), !options.skipBlobCleanup);

  // 13. Workspace-scoped singletons (both Restrict toward Workspace).
  await deleteWorkspaceCapabilityPacks(prisma, workspaceId);
  await deleteWorkspaceAgentData(prisma, workspaceId);
  await prisma.workspaceScoringConfig.deleteMany({ where: { workspaceId } });
  await prisma.canvasNodePosition.deleteMany({ where: { workspaceId } });

  // 14. Members + squads + docs, then the workspace itself.
  await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
  await prisma.squad.deleteMany({ where: { workspaceId } });
  await prisma.doc.deleteMany({ where: { workspaceId } });
  await prisma.workspace.delete({ where: { id: workspaceId } });
}
