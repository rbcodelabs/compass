/**
 * Pure edge derivation for the Canvas viewer's OST + Roadmap graph.
 *
 * No Prisma dependency — takes the already-fetched CanvasOverview and
 * returns a flat edge list, so it's fully unit-testable with plain object
 * fixtures (no vi.mock("@/lib/db") needed).
 *
 * Edge shape mirrors the entity chain:
 *   Objective -> KeyResult -> Opportunity -> Solution -> Assumption -> Experiment
 * plus RoadmapItem, which can have up to four possible parent FKs
 * (solutionId / experimentId / opportunityId / keyResultId) since it's the
 * DAG's convergence point — a RoadmapItem promoted "from" an Experiment might
 * *also* still reference the Opportunity and KeyResult it descended from.
 * Only one of those becomes the primary (solid) edge; the rest become
 * dashed secondary edges, so the graph reads as a tree with occasional
 * cross-links rather than a confusing multi-parent tangle.
 */
import type { CanvasOverview } from "./data";

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  dashed?: boolean;
}

/** solution > experiment > opportunity > keyResult, matching the plan's
 * stated precedence — a RoadmapItem promoted from deeper in the OST tree
 * treats its most-specific origin as the "real" parent for layout purposes. */
const ROADMAP_PARENT_PRECEDENCE: readonly ["sol", "exp", "opp", "kr"] = [
  "sol",
  "exp",
  "opp",
  "kr",
];

export function buildCanvasEdges(overview: CanvasOverview): CanvasEdge[] {
  const knownIds = new Set<string>([
    ...overview.objectives.map((o) => o.id),
    ...overview.keyResults.map((kr) => kr.id),
    ...overview.opportunities.map((o) => o.id),
    ...overview.solutions.map((s) => s.id),
    ...overview.assumptions.map((a) => a.id),
    ...overview.experiments.map((e) => e.id),
    ...overview.roadmapItems.map((r) => r.id),
  ]);

  const edges: CanvasEdge[] = [];

  const addEdge = (source: string, target: string, dashed = false) => {
    // The flat-query/in-memory-join pattern has no DB-level referential
    // guarantee across separate round-trips — drop rather than throw if a
    // FK points at an id we didn't fetch (e.g. a race with a concurrent
    // delete between queries).
    if (!knownIds.has(source) || !knownIds.has(target)) return;
    edges.push({ id: `e-${source}-${target}`, source, target, dashed });
  };

  for (const kr of overview.keyResults) {
    addEdge(kr.objectiveId, kr.id);
  }

  for (const opp of overview.opportunities) {
    if (opp.linkedKeyResultId) {
      addEdge(opp.linkedKeyResultId, opp.id);
    }
  }

  for (const sol of overview.solutions) {
    addEdge(sol.opportunityId, sol.id);
  }

  for (const assumption of overview.assumptions) {
    addEdge(assumption.solutionId, assumption.id);
  }

  for (const exp of overview.experiments) {
    if (exp.assumptionId) {
      addEdge(exp.assumptionId, exp.id);
    }
  }

  for (const item of overview.roadmapItems) {
    const parentIdByKey: Record<(typeof ROADMAP_PARENT_PRECEDENCE)[number], string | null> = {
      sol: item.solutionId,
      exp: item.experimentId,
      opp: item.opportunityId,
      kr: item.keyResultId,
    };

    let primaryChosen = false;
    for (const key of ROADMAP_PARENT_PRECEDENCE) {
      const parentId = parentIdByKey[key];
      // Skip unset FKs *and* FKs pointing at an id we didn't fetch — an
      // unknown parent shouldn't consume the "primary" slot and leave a
      // valid, lower-precedence parent stranded as dashed with no solid
      // edge actually rendered.
      if (!parentId || !knownIds.has(parentId)) continue;

      addEdge(parentId, item.id, primaryChosen);
      primaryChosen = true;
    }
    // Zero resolvable parents (feedback-only or none set) -> orphan node,
    // no edges added — handled naturally by the loop adding nothing.
  }

  return edges;
}
