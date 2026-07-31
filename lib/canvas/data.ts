/**
 * Server-side data loader for the Canvas viewer.
 *
 * Flat-query-plus-in-memory-join, mirroring okrs/[cycleId]/page.tsx's
 * objective.findMany -> keyResult.findMany({objectiveId:{in}}) -> grouped
 * join style rather than a deep Prisma `include` (same rationale: keeps each
 * query cheap and predictable at scale). Kept here in lib/ — not inlined in
 * the page — so it's testable via the `vi.mock("@/lib/db")` pattern used in
 * __tests__/actions/okrs.test.ts, independent of Next.js request context.
 *
 * Renders the full OST + Roadmap graph in one eager pass: Objective ->
 * KeyResult -> Opportunity -> Solution -> Assumption -> Experiment, plus
 * RoadmapItem (a DAG leaf with up to 4 possible parent FKs — see
 * lib/canvas/edges.ts for how those resolve to edges). Explicitly out of
 * scope this phase: semantic zoom tiers, lazy per-KR chain fetch,
 * drag-to-pin (CanvasNodePosition stays queried-but-unwritten, same as
 * before).
 */
import type { PrismaClient } from "@prisma/client";
import type {
  ObjectiveStatus,
  OpportunityStatus,
  SolutionStatus,
  AssumptionStatus,
  RiskLevel,
  ExperimentStatus,
  Conclusion,
  Horizon,
  SquadData,
} from "@/lib/types";
import type { CanvasPosition } from "./layout";

export interface CanvasObjective {
  id: string;
  title: string;
  status: ObjectiveStatus;
  squad: SquadData | null;
  position: CanvasPosition | null;
}

export interface CanvasKeyResult {
  id: string;
  objectiveId: string;
  title: string;
  current: number;
  target: number;
  unit: string | null;
  position: CanvasPosition | null;
}

export interface CanvasOpportunity {
  id: string;
  title: string;
  status: OpportunityStatus;
  squad: SquadData | null;
  linkedKeyResultId: string | null;
  position: CanvasPosition | null;
}

export interface CanvasSolution {
  id: string;
  opportunityId: string;
  title: string;
  status: SolutionStatus;
  position: CanvasPosition | null;
}

export interface CanvasAssumption {
  id: string;
  solutionId: string;
  title: string;
  riskLevel: RiskLevel;
  status: AssumptionStatus;
  position: CanvasPosition | null;
}

export interface CanvasExperiment {
  id: string;
  assumptionId: string | null;
  title: string;
  squad: SquadData | null;
  status: ExperimentStatus;
  conclusion: Conclusion | null;
  position: CanvasPosition | null;
}

export interface CanvasRoadmapItem {
  id: string;
  title: string;
  horizon: Horizon;
  squad: SquadData | null;
  solutionId: string | null;
  keyResultId: string | null;
  opportunityId: string | null;
  experimentId: string | null;
  isBug: boolean;
  position: CanvasPosition | null;
}

export interface CanvasOverview {
  objectives: CanvasObjective[];
  keyResults: CanvasKeyResult[];
  opportunities: CanvasOpportunity[];
  solutions: CanvasSolution[];
  assumptions: CanvasAssumption[];
  experiments: CanvasExperiment[];
  roadmapItems: CanvasRoadmapItem[];
}

/**
 * Loads the entire connected OST + Roadmap graph for a workspace, plus any
 * saved CanvasNodePosition rows so pinned nodes render at their saved spot.
 *
 * Deliberately no `status` filter on Opportunity/Solution/Assumption/
 * Experiment queries — excluding e.g. ARCHIVED Opportunities would create
 * dangling edges for any Solution/RoadmapItem still pointing at one.
 * RoadmapItem is the one exception (status: "ACTIVE"): it's always an edge
 * *target*, never a source, so filtering it can't orphan anything downstream.
 *
 * Experiments are queried directly by workspaceId (not nested via
 * Assumption) so independent Experiments with no assumptionId are still
 * caught — diverging on purpose from the opportunity detail page's nested
 * `include`.
 */
export async function getCanvasOverview(
  prisma: PrismaClient,
  workspaceId: string
): Promise<CanvasOverview> {
  // ── Batch 1: workspace-scoped, no FK dependency on anything fetched below ──
  const [squadsRaw, objectivesRaw, opportunitiesRaw, experimentsRaw, roadmapItemsRaw] =
    await Promise.all([
      prisma.squad.findMany({ where: { workspaceId } }),
      prisma.objective.findMany({
        where: { cycle: { workspaceId } },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      }),
      prisma.opportunity.findMany({
        where: { workspaceId },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      }),
      prisma.experiment.findMany({
        where: { workspaceId },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      }),
      prisma.roadmapItem.findMany({
        where: { workspaceId, status: "ACTIVE" },
        include: { feedback: { select: { type: true } } },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      }),
    ]);

  const squadById = new Map<string, SquadData>(
    squadsRaw.map((s) => [s.id, { id: s.id, name: s.name, color: s.color }])
  );

  const objectiveIds = objectivesRaw.map((o) => o.id);
  const opportunityIds = opportunitiesRaw.map((o) => o.id);

  // ── Batch 2: depends on batch 1 ids ─────────────────────────────────────
  const [keyResultsRaw, solutionsRaw] = await Promise.all([
    objectiveIds.length > 0
      ? prisma.keyResult.findMany({
          where: { objectiveId: { in: objectiveIds } },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        })
      : Promise.resolve([]),
    opportunityIds.length > 0
      ? prisma.solution.findMany({
          where: { opportunityId: { in: opportunityIds } },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        })
      : Promise.resolve([]),
  ]);

  const solutionIds = solutionsRaw.map((s) => s.id);

  // ── Batch 3: depends on batch 2 ids ─────────────────────────────────────
  const assumptionsRaw =
    solutionIds.length > 0
      ? await prisma.assumption.findMany({
          where: { solutionId: { in: solutionIds } },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        })
      : [];

  // ── Positions: one round-trip covering every fetched entity id ─────────
  const entityIds = [
    ...objectiveIds,
    ...keyResultsRaw.map((kr) => kr.id),
    ...opportunityIds,
    ...solutionIds,
    ...assumptionsRaw.map((a) => a.id),
    ...experimentsRaw.map((e) => e.id),
    ...roadmapItemsRaw.map((r) => r.id),
  ];

  const positionsRaw =
    entityIds.length > 0
      ? await prisma.canvasNodePosition.findMany({
          where: {
            workspaceId,
            entityType: {
              in: [
                "OBJECTIVE",
                "KEY_RESULT",
                "OPPORTUNITY",
                "SOLUTION",
                "ASSUMPTION",
                "EXPERIMENT",
                "ROADMAP_ITEM",
              ],
            },
            entityId: { in: entityIds },
          },
        })
      : [];

  const positionByEntity = new Map<string, CanvasPosition>(
    positionsRaw.map((p) => [
      `${p.entityType}:${p.entityId}`,
      { x: p.x, y: p.y, pinned: p.pinned },
    ])
  );

  // ── Map to typed shapes + join squads/positions back in ────────────────
  const objectives: CanvasObjective[] = objectivesRaw.map((obj) => ({
    id: obj.id,
    title: obj.title,
    status: obj.status as ObjectiveStatus,
    squad: obj.squadId ? (squadById.get(obj.squadId) ?? null) : null,
    position: positionByEntity.get(`OBJECTIVE:${obj.id}`) ?? null,
  }));

  const keyResults: CanvasKeyResult[] = keyResultsRaw.map((kr) => ({
    id: kr.id,
    objectiveId: kr.objectiveId,
    title: kr.title,
    current: kr.current,
    target: kr.target,
    unit: kr.unit,
    position: positionByEntity.get(`KEY_RESULT:${kr.id}`) ?? null,
  }));

  const opportunities: CanvasOpportunity[] = opportunitiesRaw.map((opp) => ({
    id: opp.id,
    title: opp.title,
    status: opp.status as OpportunityStatus,
    squad: opp.squadId ? (squadById.get(opp.squadId) ?? null) : null,
    linkedKeyResultId: opp.linkedKeyResultId,
    position: positionByEntity.get(`OPPORTUNITY:${opp.id}`) ?? null,
  }));

  const solutions: CanvasSolution[] = solutionsRaw.map((sol) => ({
    id: sol.id,
    opportunityId: sol.opportunityId,
    title: sol.title,
    status: sol.status as SolutionStatus,
    position: positionByEntity.get(`SOLUTION:${sol.id}`) ?? null,
  }));

  const assumptions: CanvasAssumption[] = assumptionsRaw.map((a) => ({
    id: a.id,
    solutionId: a.solutionId,
    title: a.title,
    riskLevel: a.riskLevel as RiskLevel,
    status: a.status as AssumptionStatus,
    position: positionByEntity.get(`ASSUMPTION:${a.id}`) ?? null,
  }));

  const experiments: CanvasExperiment[] = experimentsRaw.map((exp) => ({
    id: exp.id,
    assumptionId: exp.assumptionId,
    title: exp.title,
    squad: exp.squadId ? (squadById.get(exp.squadId) ?? null) : null,
    status: exp.status as ExperimentStatus,
    conclusion: exp.conclusion as Conclusion | null,
    position: positionByEntity.get(`EXPERIMENT:${exp.id}`) ?? null,
  }));

  const roadmapItems: CanvasRoadmapItem[] = roadmapItemsRaw.map((item) => ({
    id: item.id,
    title: item.title,
    horizon: item.horizon as Horizon,
    squad: item.squadId ? (squadById.get(item.squadId) ?? null) : null,
    solutionId: item.solutionId,
    keyResultId: item.keyResultId,
    opportunityId: item.opportunityId,
    experimentId: item.experimentId,
    isBug: item.feedback?.type === "BUG",
    position: positionByEntity.get(`ROADMAP_ITEM:${item.id}`) ?? null,
  }));

  return {
    objectives,
    keyResults,
    opportunities,
    solutions,
    assumptions,
    experiments,
    roadmapItems,
  };
}
