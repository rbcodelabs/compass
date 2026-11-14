import type { AppPrismaClient } from "@/lib/db";
import { getArtifactStorage } from "@/lib/artifact-storage";
import { deleteWorkspaceArtifacts } from "@/lib/artifacts";
import { deleteWorkspaceDecisionData } from "@/lib/delete-workspace-decision-data";
import { deleteWorkspaceCapabilityPacks } from "@/lib/capability-pack-cleanup";
import { deleteWorkspaceAgentData } from "@/lib/agent-lifecycle";
import { deleteWorkspaceUpdates } from "@/lib/workspace-updates-cleanup";
import { deleteWorkspaceNotifications } from "@/lib/follow-cleanup";
import { deleteWorkspaceResearchData } from "@/lib/research-workspace-cleanup";
import { assertDocumentPilotCleanupReviewed } from "@/lib/document-cleanup";
import { deleteWorkspaceAnalytics } from "@/lib/analytics/service";
import { drainLinksFor } from "@/lib/typed-links";
import { deleteLinksForEntity, deleteWorkspaceLinks } from "@/lib/links/service";
import { deleteLinksOfTasks } from "@/lib/task-link-writes";
import { updateInBatches } from "@/lib/batched-delete";
import { sweepWorkspaceOwnedRows } from "@/lib/workspace-export/sweep";

/**
 * Aurora DSQL fails a transaction that modifies more than ~3,000 rows, and the workspace_id indexes on Solution and
 * Objective add an index entry per modified row. Every multi-row write below that is driven by an id list is split into
 * chunks of this size, one statement (one transaction) each.
 */
export const CASCADE_CHUNK_SIZE = 500;

export function chunked<T>(list: readonly T[], size: number = CASCADE_CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

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
export async function deleteWorkspaceCascade(prisma: AppPrismaClient, workspaceId: string, options: { skipBlobCleanup?: boolean } = {}) {
  await assertDocumentPilotCleanupReviewed(prisma, workspaceId);

  // 0. entity_links, FIRST: the only store of every link family (opportunity-to-objective, solution-to-key-result, task references, artifact and
  //    generic links). No foreign key or emulated relation reaches the table, so rows are deleted explicitly: by the workspaceId stamped on the
  //    row (indexed, in committed passes because each link is several DSQL-modified rows), then by endpoint id in the steps below for rows whose
  //    workspaceId drifted. It is first on purpose: failing here mutates nothing, where failing later would leave the objective
  //    parentKeyResultId pointers already nulled.
  await deleteWorkspaceLinks(prisma, workspaceId);
  const ids = async (
    rows: Promise<{ id: string }[]>
  ): Promise<string[]> => (await rows).map((r) => r.id);

  // 0b. Comment threads and card sorts point at many other records (artifacts, custom fields, any commentable entity), so they are
  //     cleared before the steps that delete those, or an emulated Restrict from a leftover comment anchor or card sort round blocks them.
  await sweepWorkspaceOwnedRows(prisma, workspaceId, {
    only: ["CommentElementAnchor", "DocCommentAnchor", "SolutionPlanProposal", "CommentExternalAuthor", "Comment", "CardSortNewEntry", "CardSortProposal", "CardSortRound"],
  });

  // 1. Break the KeyResult↔Objective Restrict cycle.
  //
  // Solutions and Objectives are selected by their own workspaceId (migration
  // 068), plus, only while it is still NULL, by the parent chain. Teardown must
  // be complete, so unlike the authorization paths it also reaches un-backfilled
  // rows; it never reaches a row whose workspaceId names a different workspace.
  const ownedCycleIds = await ids(
    prisma.oKRCycle.findMany({ where: { workspaceId }, select: { id: true } })
  );
  // A row is ours by its own workspaceId, or (only while that is still NULL) by its parent. Matching the
  // parent unconditionally would let a row whose own workspaceId names ANOTHER workspace be deleted with this one.
  //
  // Drift residue: a Solution whose own workspaceId names ANOTHER workspace but whose opportunity is ours is neither
  // selected nor deleted here, so the opportunity delete below fails loudly on its emulated Restrict. That is the
  // intended outcome (a drifted row is data corruption someone should look at), not something to paper over by deleting
  // another tenant's row.
  const objectiveIds = await ids(
    prisma.objective.findMany({ where: { OR: [{ workspaceId }, { workspaceId: null, cycleId: { in: ownedCycleIds } }] }, select: { id: true } })
  );
  for (const chunk of chunked(objectiveIds)) {
    await prisma.objective.updateMany({
      where: { id: { in: chunk } },
      data: { parentKeyResultId: null },
    });
  }

  await deleteWorkspaceResearchData(prisma, workspaceId);

  // 2. Null Experiment.assumptionId so assumptions can be deleted later.
  await prisma.experiment.updateMany({
    where: { workspaceId },
    data: { assumptionId: null },
  });

  // entity_links rows that name a review request (task links, ADR phase 7), by endpoint so a drifted workspace_id is covered too.
  const reviewRequestIds = await ids(prisma.reviewRequest.findMany({ where: { workspaceId }, select: { id: true } }));
  if (reviewRequestIds.length > 0) await deleteLinksForEntity(prisma, "REVIEW_REQUEST", reviewRequestIds);

  // Decision/release/capacity aggregates reference Tasks and RoadmapItems.
  // DSQL has no FK cascades, so clear the full child graph first.
  await deleteWorkspaceDecisionData(prisma, workspaceId);

  // 3. Tasks + their links. A parent and its subtasks cannot go in one statement either: the emulated
  //    Restrict on Task.parentTaskId refuses it (P2014) even though every row is being deleted, so the tree is detached first.
  const taskIds = await ids(
    prisma.task.findMany({ where: { workspaceId }, select: { id: true } })
  );
  if (taskIds.length > 0) {
    // Every task link (references and origins) lives in entity_links and goes first, by endpoint.
    await deleteLinksOfTasks(prisma, taskIds);
  }
  await updateInBatches(prisma.task, { workspaceId, parentTaskId: { not: null } }, { parentTaskId: null });
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
    await deleteLinksForEntity(prisma, "ROADMAP_ITEM", roadmapItemIds);
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
    await prisma.feedbackElementAnchor.deleteMany({
      where: { feedbackItemId: { in: feedbackIds } },
    });
    await deleteLinksForEntity(prisma, "FEEDBACK_ITEM", feedbackIds);
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
  // Shared option sets last: the delete guard only blocks while definitions
  // still reference them, and those are gone by this point.
  await prisma.sharedFieldOptionSet.deleteMany({ where: { workspaceId } });

  // 8. Evidence (Restrict on workspace; SetNull toward opp/solution/assumption).
  await prisma.evidence.deleteMany({ where: { workspaceId } });

  // 9. Opportunity subtree: scores → assumptions/comments → solutions → opps.
  const opportunityIds = await ids(
    prisma.opportunity.findMany({ where: { workspaceId }, select: { id: true } })
  );
  for (const chunk of chunked(opportunityIds)) {
    await prisma.opportunityScore.deleteMany({
      where: { opportunityId: { in: chunk } },
    });
    await drainLinksFor(prisma, "opportunity", chunk);
  }
  const solutionIds = await ids(
    prisma.solution.findMany({
      where: { OR: [{ workspaceId }, { workspaceId: null, opportunityId: { in: opportunityIds } }] },
      select: { id: true },
    })
  );
  for (const chunk of chunked(solutionIds)) {
    await prisma.solutionScore.deleteMany({
      where: { solutionId: { in: chunk } },
    });
    await drainLinksFor(prisma, "solution", chunk);
    await prisma.assumption.deleteMany({
      where: { solutionId: { in: chunk } },
    });
    await prisma.solutionComment.deleteMany({
      where: { solutionId: { in: chunk } },
    });
    await prisma.solution.deleteMany({ where: { id: { in: chunk } } });
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
    await deleteLinksForEntity(prisma, "EXPERIMENT", experimentIds);
  }
  await prisma.experiment.deleteMany({ where: { workspaceId } });

  // 11. OKR subtree: check-ins → key results → objectives → cycles.
  for (const objectiveChunk of chunked(objectiveIds)) {
    const keyResultIds = await ids(
      prisma.keyResult.findMany({
        where: { objectiveId: { in: objectiveChunk } },
        select: { id: true },
      })
    );
    for (const keyResultChunk of chunked(keyResultIds)) {
      await prisma.checkIn.deleteMany({
        where: { keyResultId: { in: keyResultChunk } },
      });
      await drainLinksFor(prisma, "keyResult", keyResultChunk);
      await prisma.keyResult.deleteMany({
        where: { id: { in: keyResultChunk } },
      });
    }
    await drainLinksFor(prisma, "objective", objectiveChunk);
    await prisma.objective.deleteMany({ where: { id: { in: objectiveChunk } } });
  }
  await prisma.oKRCycle.deleteMany({ where: { workspaceId } });

  // 11b. Embed feedback sources. Visitor sessions and auth handoffs first (both
  //      Restrict toward the source, and easy to miss since a widget visitor
  //      only ever produces them once someone actually signs in or starts to),
  //      then tokens (also Restrict toward the source), and the whole group
  //      before artifacts, since a bound source references one.
  await prisma.embedVisitorSession.deleteMany({
    where: { feedbackSource: { workspaceId } },
  });
  await prisma.embedAuthHandoff.deleteMany({
    where: { feedbackSource: { workspaceId } },
  });
  // CommentExternalAuthor.embedTokenId is a bare uuid column with no @relation to
  // FeedbackSourceToken, so it is never covered by Restrict emulation and would
  // dangle once tokens are deleted below — null it out first rather than leaving
  // a comment's external-author row pointing at a token that no longer exists.
  const tokenIds = await ids(
    prisma.feedbackSourceToken.findMany({ where: { feedbackSource: { workspaceId } }, select: { id: true } })
  );
  if (tokenIds.length > 0) {
    await prisma.commentExternalAuthor.updateMany({
      where: { embedTokenId: { in: tokenIds } },
      data: { embedTokenId: null },
    });
  }
  await prisma.feedbackSourceToken.deleteMany({
    where: { feedbackSource: { workspaceId } },
  });
  await prisma.feedbackSource.deleteMany({ where: { workspaceId } });

  // 12. Artifacts: links → current pointer → revisions → stable identity,
  // followed by best-effort private Blob cleanup. Artifact links (entity_links) are swept by endpoint first, so
  // rows whose workspaceId drifted go too; the stamped ones are already gone with step 0.
  await deleteLinksForEntity(prisma, "ARTIFACT", await ids(prisma.artifact.findMany({ where: { workspaceId }, select: { id: true } })));
  await deleteWorkspaceArtifacts(prisma, workspaceId, getArtifactStorage(), !options.skipBlobCleanup);

  // 13. Workspace-scoped singletons (both Restrict toward Workspace).
  await deleteWorkspaceCapabilityPacks(prisma, workspaceId);
  await deleteWorkspaceAgentData(prisma, workspaceId);
  await deleteWorkspaceUpdates(prisma, workspaceId);
  await deleteWorkspaceNotifications(prisma, workspaceId);
  await prisma.workspaceScoringConfig.deleteMany({ where: { workspaceId } });
  await prisma.canvasNodePosition.deleteMany({ where: { workspaceId } });
  await prisma.portalHomeLayout.deleteMany({ where: { workspaceId } });
  await prisma.savedView.deleteMany({ where: { workspaceId } });
  // Work item ID counters (migration 092): no FK reaches this table, so it is deleted explicitly.
  await prisma.workspaceSequence.deleteMany({ where: { workspaceId } });

  // 14. Squads + docs, a final sweep, then members and the workspace itself.
  await prisma.squad.deleteMany({ where: { workspaceId } });
  const docIds = await ids(prisma.doc.findMany({ where: { workspaceId }, select: { id: true } }));
  if (docIds.length > 0) await deleteLinksForEntity(prisma, "DOC", docIds);
  // Version snapshots and doc comments hold a required relation to Doc, so the docs cannot go while any exist (P2014); comment replies
  // and doc trees are self-referencing for the same reason. The sweep removes the whole family children-first, in bounded batches.
  await sweepWorkspaceOwnedRows(prisma, workspaceId, { only: ["DocVersion", "DocComment", "Doc"] });
  await prisma.doc.deleteMany({ where: { workspaceId } });

  // Backstop for anything the steps above do not know about (workspace-wide Comment rows, card sorts, modules, and whatever is added
  // next): every model in the export registry that still holds rows for this workspace is removed, children first.
  await sweepWorkspaceOwnedRows(prisma, workspaceId);

  // Members go LAST, in the same transaction as the workspace row. Deleting them earlier meant a failure further down left a
  // workspace nobody could open, delete or retry; now a failed delete leaves it fully accessible and this function can simply be re-run.
  await prisma.$transaction(async tx => {
    await tx.workspaceMember.deleteMany({ where: { workspaceId } });
    await tx.workspace.delete({ where: { id: workspaceId } });
    await deleteWorkspaceAnalytics(tx, workspaceId);
  });
}
