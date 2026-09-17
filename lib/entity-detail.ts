/**
 * Shared single-entity detail fetching for the workspace detail panels.
 *
 * One place that, given an entity `type` + `id` + the caller's `workspaceId`,
 * returns that entity with the relations a detail panel needs — or `null` if
 * it doesn't exist *in that workspace*. Every screen's detail panel (Canvas,
 * OKRs, Discovery, Experiments, Roadmap, Feedback) fetches through this, so
 * the query shapes and — critically — the access-control scoping live in a
 * single audited spot instead of being re-derived per route.
 *
 * ## Access control
 * The previous ad-hoc panel routes did `findUnique({ where: { id } })` with
 * only a session check, so any signed-in user could read any entity in any
 * workspace by guessing/knowing its id (an IDOR). Here, every query is
 * constrained to the caller's `workspaceId`:
 *   - Directly workspace-scoped entities (Opportunity, Experiment,
 *     RoadmapItem, Feedback) filter on their own `workspaceId`.
 *   - Indirectly scoped entities filter through their parent chain via
 *     Prisma relation filters — a Solution only resolves if *its Opportunity*
 *     is in the workspace, an Assumption through Solution -> Opportunity, a
 *     KeyResult through Objective -> OKRCycle, an Objective through OKRCycle.
 * A miss (wrong workspace or nonexistent id) returns `null`, which callers
 * surface as a 404 — never leaking cross-workspace existence.
 *
 * The route handler is responsible for proving the caller is a *member* of
 * `workspaceId` before calling this (see getWorkspace()); this module trusts
 * the `workspaceId` it's handed and only enforces that the entity belongs to
 * it.
 */
import getPrisma from "@/lib/db";
import { isPmInterviewEnabled } from "@/lib/research-feature";
import { fetchLinkedTasksBundle } from "@/lib/linked-tasks";
import { loadEvidenceProvenance, withEvidenceProvenance } from "@/lib/evidence-provenance";
import { resolveTaskAssignees } from "@/lib/task-assignment";
import { loadCustomFieldsForObject } from "@/lib/custom-field-definitions";

/**
 * ADR-0012 step 6a — the three OST detail fetchers that carry Evidence resolve
 * its research provenance here, so every panel inherits one projection rather
 * than each re-deriving it. Rows that were never promoted pass through
 * untouched and cost no extra query at all (see lib/evidence-provenance.ts).
 */
async function resolveEvidenceProvenance<
  T extends { id: string; workspaceId: string; researchSynthesisId: string | null },
>(evidence: T[]) {
  return withEvidenceProvenance(evidence, await loadEvidenceProvenance(evidence));
}

export const ENTITY_TYPES = [
  "objective",
  "keyResult",
  "opportunity",
  "solution",
  "assumption",
  "experiment",
  "roadmapItem",
  "feedback",
  "task",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export function isEntityType(value: string): value is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(value);
}

/**
 * The Prisma `where` filter that scopes an entity to a workspace — directly
 * for workspace-owned entities, or through the parent chain for the indirect
 * ones. Shared by the read fetchers and the write path (lib/entity-mutations)
 * so both enforce the exact same access boundary.
 */
export function entityScopeWhere(type: EntityType, id: string, workspaceId: string) {
  switch (type) {
    case "objective":
      return { id, cycle: { workspaceId } };
    case "keyResult":
      return { id, objective: { cycle: { workspaceId } } };
    case "solution":
      return { id, opportunity: { workspaceId } };
    case "assumption":
      return { id, solution: { opportunity: { workspaceId } } };
    case "opportunity":
    case "experiment":
    case "roadmapItem":
    case "feedback":
    case "task":
      return { id, workspaceId };
  }
}

// ── Per-entity scoped fetchers ──────────────────────────────────────────────
// Each returns the entity (with detail relations) iff it resolves inside
// `workspaceId`, else null. findFirst (not findUnique) so we can add the
// relation-based workspace filter to the where clause.

async function fetchObjective(id: string, workspaceId: string) {
  const item = await getPrisma().objective.findFirst({
    where: { id, cycle: { workspaceId } },
    include: {
      cycle: { select: { id: true, title: true, startDate: true, endDate: true } },
      squad: { select: { id: true, name: true, color: true } },
      keyResults: {
        select: { id: true, title: true, current: true, target: true, unit: true },
        orderBy: { sortOrder: "asc" },
      },
      parentKeyResult: {
        select: {
          id: true,
          title: true,
          objective: {
            select: {
              id: true,
              title: true,
              cycle: { select: { id: true, title: true, status: true } },
            },
          },
        },
      },
    },
  });
  if (!item) return null;
  return { ...item, ...(await fetchLinkedTasksBundle(workspaceId, "OBJECTIVE", id)) };
}

async function fetchKeyResult(id: string, workspaceId: string) {
  const item = await getPrisma().keyResult.findFirst({
    where: { id, objective: { cycle: { workspaceId } } },
    include: {
      objective: { select: { id: true, title: true, cycleId: true } },
      checkIns: {
        select: { id: true, value: true, note: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 10,
      },
      roadmapItems: { select: { id: true, title: true, horizon: true, status: true } },
      opportunities: { select: { id: true, title: true, status: true } },
      supportingObjectives: {
        select: {
          id: true,
          title: true,
          status: true,
          cycle: { select: { id: true, title: true } },
          squad: { select: { id: true, name: true, color: true } },
          keyResults: { select: { current: true, target: true } },
        },
        orderBy: [{ cycle: { startDate: "asc" } }, { sortOrder: "asc" }],
      },
    },
  });
  if (!item) return null;
  return { ...item, ...(await fetchLinkedTasksBundle(workspaceId, "KEY_RESULT", id)) };
}

async function pmInterviewHistory(workspaceId: string, targetType: string, targetId: string) {
  const delegate = getPrisma().pMInterview
  return delegate?.findMany ? delegate.findMany({ where: { workspaceId, targetType, targetId }, select: { id: true, disposition: true, generationState: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 20 }) : []
}

async function fetchOpportunity(id: string, workspaceId: string) {
  const item = await getPrisma().opportunity.findFirst({
    where: { id, workspaceId },
    include: {
      linkedKeyResult: {
        select: {
          id: true,
          title: true,
          current: true,
          target: true,
          unit: true,
          objective: { select: { id: true, title: true, cycleId: true } },
        },
      },
      squad: { select: { id: true, name: true, color: true } },
      solutions: {
        select: { id: true, title: true, status: true },
        orderBy: { sortOrder: "asc" },
      },
      evidence: { orderBy: { createdAt: "desc" } },
      score: {
        select: { normalizedScore: true, rawScore: true, modelVersion: true, scoredAt: true },
      },
      // Nested on the existing opportunity fetch (no extra round trip) so the
      // panel can apply the same gate as the board: show a score only when the
      // workspace has an active model, and derive staleness from its live
      // version. See lib/scoring-model.ts.
      workspace: {
        select: {
          scoringConfig: {
            select: { scoringModel: { select: { id: true, name: true, version: true } } },
          },
        },
      },
      feedback: {
        where: { workspaceId },
        select: { id: true, title: true, type: true, status: true },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      },
      roadmapItems: { select: { id: true, title: true, horizon: true } },
    },
  });
  if (!item) return null;
  const [pmInterviews, linkedTasks, evidence] = await Promise.all([
    pmInterviewHistory(workspaceId, "OPPORTUNITY", id),
    fetchLinkedTasksBundle(workspaceId, "OPPORTUNITY", id),
    resolveEvidenceProvenance(item.evidence),
  ]);
  return { ...item, evidence, ...linkedTasks, pmInterviewEnabled: isPmInterviewEnabled(), pmInterviews };
}

async function fetchSolution(id: string, workspaceId: string) {
  const prisma = getPrisma()
  const solution = await prisma.solution.findFirst({
    where: { id, opportunity: { workspaceId } },
    include: {
      opportunity: { select: { id: true, title: true, workspaceId: true, squadId: true } },
      assumptions: {
        select: {
          id: true,
          title: true,
          riskLevel: true,
          status: true,
          sortOrder: true,
          _count: { select: { evidence: true } },
          experiments: { select: { id: true } },
        },
        orderBy: { sortOrder: "asc" },
      },
      evidence: { orderBy: { createdAt: "desc" } },
      // Chronological (oldest first) and unbounded — the panel's Plan &
      // Discussion thread needs the full history, not just the latest 20, to
      // reliably find the pinned "current plan" (last PLAN entry).
      comments: { orderBy: { createdAt: "asc" } },
      roadmapItems: { select: { id: true, title: true, horizon: true } },
    },
  });
  if (!solution) return null
  const [links, availableArtifacts, pmInterviews, linkedTasks, evidence, customFields] = await Promise.all([
    prisma.artifactLink.findMany({ where: { workspaceId, linkedType: "SOLUTION", linkedId: id }, select: { artifactId: true } }),
    prisma.artifact.findMany({ where: { workspaceId, status: "ACTIVE" }, select: { id: true, title: true, sourceType: true }, orderBy: { title: "asc" } }),
    pmInterviewHistory(workspaceId, "SOLUTION", id),
    fetchLinkedTasksBundle(workspaceId, "SOLUTION", id),
    resolveEvidenceProvenance(solution.evidence),
    // A Solution has no detail route — its panel is the only place its tags can
    // be set, which is what the shipped SOLUTION tag filter reads.
    loadCustomFieldsForObject(prisma, { workspaceId, objectType: "SOLUTION", objectId: id }),
  ])
  const linkedIds = new Set(links.map((link) => link.artifactId))
  return { ...solution, evidence, ...linkedTasks, artifacts: availableArtifacts.filter((artifact) => linkedIds.has(artifact.id)), availableArtifacts, pmInterviewEnabled: isPmInterviewEnabled(), pmInterviews, customFields }
}

async function fetchAssumption(id: string, workspaceId: string) {
  const item = await getPrisma().assumption.findFirst({
    where: { id, solution: { opportunity: { workspaceId } } },
    include: {
      solution: {
        select: {
          id: true,
          title: true,
          opportunity: { select: { id: true, title: true } },
        },
      },
      experiments: { select: { id: true, title: true, status: true, conclusion: true } },
      evidence: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!item) return null
  const [pmInterviews, evidence] = await Promise.all([
    pmInterviewHistory(workspaceId, "ASSUMPTION", id),
    resolveEvidenceProvenance(item.evidence),
  ])
  return { ...item, evidence, pmInterviewEnabled: isPmInterviewEnabled(), pmInterviews }
}

async function fetchExperiment(id: string, workspaceId: string) {
  const item = await getPrisma().experiment.findFirst({
    where: { id, workspaceId },
    include: {
      assumption: {
        select: {
          id: true,
          title: true,
          riskLevel: true,
          solution: { select: { id: true, title: true } },
        },
      },
      squad: { select: { id: true, name: true, color: true } },
      results: {
        select: { id: true, note: true, metric: true, value: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      },
      roadmapItems: { select: { id: true, title: true, horizon: true } },
    },
  });
  if (!item) return null;
  const [pmInterviews, linkedTasks] = await Promise.all([
    pmInterviewHistory(workspaceId, "EXPERIMENT", id),
    fetchLinkedTasksBundle(workspaceId, "EXPERIMENT", id),
  ]);
  return { ...item, ...linkedTasks, pmInterviewEnabled: isPmInterviewEnabled(), pmInterviews };
}

async function fetchRoadmapItem(id: string, workspaceId: string) {
  const prisma = getPrisma();
  const item = await prisma.roadmapItem.findFirst({
    where: { id, workspaceId },
    include: {
      squad: { select: { id: true, name: true, color: true } },
      solution: { select: { id: true, title: true } },
      keyResult: { select: { id: true, title: true } },
      opportunity: { select: { id: true, title: true } },
      experiment: { select: { id: true, title: true } },
      feedback: { select: { id: true, title: true } },
      // Launch section: the item's checklist (with ordered items) and its 1:1
      // positioning brief, if either exists. `horizon` is already a scalar.
      launchChecklist: { include: { items: { orderBy: { order: "asc" } } } },
      positioningBrief: { select: { id: true, title: true } },
      _count: { select: { votes: true } },
    },
  });
  if (!item) return null;

  const [linkedTasks, customFields] = await Promise.all([
    fetchLinkedTasksBundle(workspaceId, "ROADMAP_ITEM", id),
    // A RoadmapItem has no detail route — its panel is the only place its tags
    // can be set, which is what the shipped ROADMAP_ITEM tag filter reads.
    loadCustomFieldsForObject(prisma, { workspaceId, objectType: "ROADMAP_ITEM", objectId: id }),
  ]);

  return { ...item, ...linkedTasks, customFields };
}

async function fetchFeedback(id: string, workspaceId: string) {
  const item = await getPrisma().feedbackItem.findFirst({
    where: { id, workspaceId },
    include: {
      opportunity: { select: { id: true, title: true } },
      attachments: {
        select: { id: true, url: true, filename: true, fileType: true, fileSize: true },
      },
      _count: { select: { votes: true } },
    },
  });
  if (!item) return null;
  return { ...item, ...(await fetchLinkedTasksBundle(workspaceId, "FEEDBACK_ITEM", id)) };
}

// The candidate pools for TaskDetail's "link to another item" picker — same
// shape LinkTaskDialog's `LinkableTargets` already consumes.
const LINK_TARGET_MODEL = {
  OPPORTUNITY: "opportunity",
  SOLUTION: "solution",
  ROADMAP_ITEM: "roadmapItem",
  OBJECTIVE: "objective",
  KEY_RESULT: "keyResult",
  DOC: "doc",
  EXPERIMENT: "experiment",
  FEEDBACK_ITEM: "feedbackItem",
} as const;

/**
 * Task is materially heavier than the other eight types: unlike a Solution or
 * Objective, its panel needs bundled sibling data (squads/members for
 * pickers, linkable targets for the link dialog, custom fields) alongside the
 * entity itself — mirroring fetchRoadmapItem's pattern of bundling what the
 * panel needs in one fetch rather than the client making several round trips.
 */
async function fetchTask(id: string, workspaceId: string) {
  const prisma = getPrisma();
  const task = await prisma.task.findFirst({
    where: { id, workspaceId },
    include: {
      squad: { select: { id: true, name: true, color: true } },
      links: true,
      parentTask: { select: { id: true, title: true } },
      subtasks: {
        orderBy: { sortOrder: "asc" },
        include: {
          squad: { select: { id: true, name: true, color: true } },
          links: true,
          _count: { select: { subtasks: true } },
        },
      },
    },
  });
  if (!task) return null;

  const [rawSquads, rawMembers, customFields, [resolvedTask, ...resolvedSubtasks]] = await Promise.all([
    prisma.squad.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } }),
    prisma.workspaceMember.findMany({
      where: { workspaceId },
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    loadCustomFieldsForObject(prisma, { workspaceId, objectType: "TASK", objectId: id }),
    resolveTaskAssignees(workspaceId, [task, ...task.subtasks]),
  ]);

  // Batch-resolve titles for every link on this task and its subtasks.
  const allLinks = [...task.links, ...task.subtasks.flatMap((s) => s.links)];
  const linksByType = new Map<string, string[]>();
  for (const link of allLinks) {
    const ids = linksByType.get(link.linkedType) ?? [];
    ids.push(link.linkedId);
    linksByType.set(link.linkedType, ids);
  }
  const titleById = new Map<string, string>();
  await Promise.all(
    Array.from(linksByType.entries()).map(async ([linkedType, ids]) => {
      // DECISION (ReviewRequest) has no flat `title` column — its title lives
      // on the current revision, so it can't go through the generic
      // model-lookup dispatch below.
      if (linkedType === "DECISION") {
        const rows = await prisma.reviewRequest.findMany({
          where: { id: { in: ids }, workspaceId },
          select: { id: true, currentRevision: { select: { title: true } } },
        });
        for (const row of rows) titleById.set(`DECISION:${row.id}`, row.currentRevision?.title ?? "Untitled decision");
        return;
      }
      const modelName = LINK_TARGET_MODEL[linkedType as keyof typeof LINK_TARGET_MODEL];
      if (!modelName) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows: { id: string; title: string }[] = await (prisma as any)[modelName].findMany({
        where: { id: { in: ids } },
        select: { id: true, title: true },
      });
      for (const row of rows) titleById.set(`${linkedType}:${row.id}`, row.title);
    })
  );
  const resolveLinks = (links: typeof task.links) =>
    links.map((l) => ({
      id: l.id,
      linkedType: l.linkedType,
      linkedId: l.linkedId,
      linkedTitle: titleById.get(`${l.linkedType}:${l.linkedId}`) ?? "(deleted)",
    }));

  // Candidate pools for the "link to another item" dialog — same shape used
  // by LinkTaskDialog's `linkableTargets` prop.
  const [opps, sols, roadmapItems, objectives, keyResults, docs, experiments, feedbackItems, decisionRequests] =
    await Promise.all([
      prisma.opportunity.findMany({ where: { workspaceId }, select: { id: true, title: true }, orderBy: { createdAt: "asc" } }),
      prisma.solution.findMany({ where: { opportunity: { workspaceId } }, select: { id: true, title: true }, orderBy: { createdAt: "asc" } }),
      prisma.roadmapItem.findMany({ where: { workspaceId }, select: { id: true, title: true }, orderBy: { createdAt: "asc" } }),
      prisma.objective.findMany({ where: { cycle: { workspaceId } }, select: { id: true, title: true }, orderBy: { createdAt: "asc" } }),
      prisma.keyResult.findMany({ where: { objective: { cycle: { workspaceId } } }, select: { id: true, title: true }, orderBy: { createdAt: "asc" } }),
      prisma.doc.findMany({ where: { workspaceId }, select: { id: true, title: true }, orderBy: { createdAt: "asc" } }),
      prisma.experiment.findMany({ where: { workspaceId }, select: { id: true, title: true }, orderBy: { createdAt: "asc" } }),
      prisma.feedbackItem.findMany({ where: { workspaceId }, select: { id: true, title: true }, orderBy: { createdAt: "asc" } }),
      prisma.reviewRequest.findMany({ where: { workspaceId, gateType: "TRACKED_DECISION" }, select: { id: true, currentRevision: { select: { title: true } } }, orderBy: { createdAt: "asc" } }),
    ]);
  const decisions = decisionRequests.map((r) => ({ id: r.id, title: r.currentRevision?.title ?? "Untitled decision" }));
  const linkableTargets = {
    OPPORTUNITY: opps,
    SOLUTION: sols,
    ROADMAP_ITEM: roadmapItems,
    OBJECTIVE: objectives,
    KEY_RESULT: keyResults,
    DOC: docs,
    EXPERIMENT: experiments,
    FEEDBACK_ITEM: feedbackItems,
    DECISION: decisions,
  };

  return {
    ...resolvedTask,
    links: resolveLinks(task.links),
    subtasks: task.subtasks.map((s, i) => ({ ...resolvedSubtasks[i], links: resolveLinks(s.links) })),
    squads: rawSquads,
    members: rawMembers.map((m) => ({
      id: m.id,
      userId: m.userId,
      role: m.role,
      email: m.user.email,
      name: m.user.name,
    })),
    linkableTargets,
    customFields,
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Self-describing detail payload: the discriminant `type` plus the fetched
 * entity `data`. Clients already know the type they asked for, but tagging the
 * response keeps a generic (type, id) fetcher unambiguous and future-proofs a
 * single dispatch on the client side.
 */
export type EntityDetail =
  | { type: "objective"; data: NonNullable<Awaited<ReturnType<typeof fetchObjective>>> }
  | { type: "keyResult"; data: NonNullable<Awaited<ReturnType<typeof fetchKeyResult>>> }
  | { type: "opportunity"; data: NonNullable<Awaited<ReturnType<typeof fetchOpportunity>>> }
  | { type: "solution"; data: NonNullable<Awaited<ReturnType<typeof fetchSolution>>> }
  | { type: "assumption"; data: NonNullable<Awaited<ReturnType<typeof fetchAssumption>>> }
  | { type: "experiment"; data: NonNullable<Awaited<ReturnType<typeof fetchExperiment>>> }
  | { type: "roadmapItem"; data: NonNullable<Awaited<ReturnType<typeof fetchRoadmapItem>>> }
  | { type: "feedback"; data: NonNullable<Awaited<ReturnType<typeof fetchFeedback>>> }
  | { type: "task"; data: NonNullable<Awaited<ReturnType<typeof fetchTask>>> };

/** The shape TaskDetail's client-side fetch receives — exported so the
 * component doesn't have to re-derive it from the fetcher's return type. */
export type TaskDetailData = NonNullable<Awaited<ReturnType<typeof fetchTask>>>;

/**
 * Fetch one entity's detail, scoped to `workspaceId`. Returns null if the
 * entity doesn't exist or belongs to a different workspace (callers → 404).
 */
export async function getEntityDetail(
  type: EntityType,
  id: string,
  workspaceId: string
): Promise<EntityDetail | null> {
  switch (type) {
    case "objective": {
      const data = await fetchObjective(id, workspaceId);
      return data ? { type, data } : null;
    }
    case "keyResult": {
      const data = await fetchKeyResult(id, workspaceId);
      return data ? { type, data } : null;
    }
    case "opportunity": {
      const data = await fetchOpportunity(id, workspaceId);
      return data ? { type, data } : null;
    }
    case "solution": {
      const data = await fetchSolution(id, workspaceId);
      return data ? { type, data } : null;
    }
    case "assumption": {
      const data = await fetchAssumption(id, workspaceId);
      return data ? { type, data } : null;
    }
    case "experiment": {
      const data = await fetchExperiment(id, workspaceId);
      return data ? { type, data } : null;
    }
    case "roadmapItem": {
      const data = await fetchRoadmapItem(id, workspaceId);
      return data ? { type, data } : null;
    }
    case "feedback": {
      const data = await fetchFeedback(id, workspaceId);
      return data ? { type, data } : null;
    }
    case "task": {
      const data = await fetchTask(id, workspaceId);
      return data ? { type, data } : null;
    }
  }
}
