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

export const ENTITY_TYPES = [
  "objective",
  "keyResult",
  "opportunity",
  "solution",
  "assumption",
  "experiment",
  "roadmapItem",
  "feedback",
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
      return { id, workspaceId };
  }
}

// ── Per-entity scoped fetchers ──────────────────────────────────────────────
// Each returns the entity (with detail relations) iff it resolves inside
// `workspaceId`, else null. findFirst (not findUnique) so we can add the
// relation-based workspace filter to the where clause.

function fetchObjective(id: string, workspaceId: string) {
  return getPrisma().objective.findFirst({
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
}

function fetchKeyResult(id: string, workspaceId: string) {
  return getPrisma().keyResult.findFirst({
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
}

function fetchOpportunity(id: string, workspaceId: string) {
  return getPrisma().opportunity.findFirst({
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
      feedback: { select: { id: true, title: true, type: true, status: true } },
      roadmapItems: { select: { id: true, title: true, horizon: true } },
    },
  });
}

function fetchSolution(id: string, workspaceId: string) {
  return getPrisma().solution.findFirst({
    where: { id, opportunity: { workspaceId } },
    include: {
      opportunity: { select: { id: true, title: true, workspaceId: true } },
      assumptions: {
        select: { id: true, title: true, riskLevel: true, status: true },
        orderBy: { sortOrder: "asc" },
      },
      evidence: { orderBy: { createdAt: "desc" } },
      comments: { orderBy: { createdAt: "desc" }, take: 20 },
      roadmapItems: { select: { id: true, title: true, horizon: true } },
    },
  });
}

function fetchAssumption(id: string, workspaceId: string) {
  return getPrisma().assumption.findFirst({
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
}

function fetchExperiment(id: string, workspaceId: string) {
  return getPrisma().experiment.findFirst({
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
}

function fetchRoadmapItem(id: string, workspaceId: string) {
  return getPrisma().roadmapItem.findFirst({
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
}

function fetchFeedback(id: string, workspaceId: string) {
  return getPrisma().feedbackItem.findFirst({
    where: { id, workspaceId },
    include: {
      opportunity: { select: { id: true, title: true } },
      attachments: {
        select: { id: true, url: true, filename: true, fileType: true, fileSize: true },
      },
      _count: { select: { votes: true } },
    },
  });
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
  | { type: "feedback"; data: NonNullable<Awaited<ReturnType<typeof fetchFeedback>>> };

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
  }
}
