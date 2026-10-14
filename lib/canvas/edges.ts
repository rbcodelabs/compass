/**
 * Pure edge derivation for the OST + Roadmap graph (canvas Doc "Build tree").
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
  /**
   * Set only on typed-link edges (Objective -> Opportunity, Solution -> Key Result). They are drawn but never fed to the layout
   * engine: a Solution -> Key Result edge closes a cycle (KR -> Opp -> Solution -> KR) and would move existing nodes.
   */
  link?: true;
}

/** The emphasis fields of the workspace's thinking model that decide which link edges are drawn (see buildCanvasEdges). */
export interface CanvasEdgeOptions {
  links?: { oppToObjective: "primary" | "secondary" | "hidden" };
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

/**
 * Typed-link edges (ADR Phase 4B). Presentation rule, identical data for every preset:
 *
 *  - A preset that hides the Opportunity<->Objective link (CLASSIC) draws only user-made (DIRECT) ones, so a CLASSIC
 *    workspace's canvas does not change just because migration 071 backfilled LEGACY links. Solution<->Key Result links are
 *    always user-made, so they are always drawn.
 *  - Any other preset draws every Opportunity<->Objective link.
 *  - A LEGACY Opportunity -> Objective link whose Objective owns the opportunity's driving Key Result is already drawn as
 *    Objective -> Key Result -> Opportunity; it is skipped so one relationship never draws two lines.
 *
 * Both ends must be nodes in this overview (the workspace-scoped loads), so a link to a hidden/foreign/NULL-workspace row
 * simply draws nothing.
 */
function buildLinkEdges(overview: CanvasOverview, options: CanvasEdgeOptions, knownIds: Set<string>): CanvasEdge[] {
  const links = overview.links;
  if (!links) return [];
  const oppToObjective = options.links?.oppToObjective ?? "hidden";

  const krObjective = new Map(overview.keyResults.map((kr) => [kr.id, kr.objectiveId]));
  const pointerObjective = new Map<string, string>();
  for (const opp of overview.opportunities) {
    const objectiveId = opp.linkedKeyResultId ? krObjective.get(opp.linkedKeyResultId) : undefined;
    if (objectiveId) pointerObjective.set(opp.id, objectiveId);
  }

  const edges: CanvasEdge[] = [];
  const seen = new Set<string>();
  const add = (source: string, target: string) => {
    const id = `l-${source}-${target}`;
    if (seen.has(id) || !knownIds.has(source) || !knownIds.has(target)) return;
    seen.add(id);
    edges.push({ id, source, target, dashed: true, link: true });
  };

  for (const link of links.opportunityObjective) {
    if (oppToObjective === "hidden" && link.origin !== "DIRECT") continue;
    if (link.origin === "LEGACY" && pointerObjective.get(link.opportunityId) === link.objectiveId) continue;
    add(link.objectiveId, link.opportunityId);
  }
  for (const link of links.solutionKeyResult) add(link.solutionId, link.keyResultId);
  return edges;
}

export function buildCanvasEdges(overview: CanvasOverview, options: CanvasEdgeOptions = {}): CanvasEdge[] {
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

  for (const objective of overview.objectives) {
    if (objective.parentKeyResultId) {
      addEdge(objective.parentKeyResultId, objective.id);
    }
  }

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

  edges.push(...buildLinkEdges(overview, options, knownIds));
  return edges;
}
