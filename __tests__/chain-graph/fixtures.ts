import type { CanvasOverview } from "@/lib/canvas/data"

const base = { position: null, squad: null }

/**
 * Objective O1 -> KR K1 -> Opp P1 -> Sol S1 -> Assumption A1 -> Experiment E1, Roadmap R1 (parents S1 primary, P1 secondary).
 * Objective O2 is unrelated except for a typed Solution->KR link from S1 to K2 (O2's KR) and an archived Opp P2 under K2.
 */
export function overviewFixture(): CanvasOverview {
  return {
    objectives: [
      { id: "o1", title: "Grow activation", status: "ON_TRACK", parentKeyResultId: null, ...base },
      { id: "o2", title: "Reduce churn", status: "AT_RISK", parentKeyResultId: null, ...base },
    ],
    keyResults: [
      { id: "k1", objectiveId: "o1", title: "KR1", current: 1, target: 2, unit: null, position: null },
      { id: "k2", objectiveId: "o2", title: "KR2", current: 1, target: 2, unit: null, position: null },
    ],
    opportunities: [
      { id: "p1", title: "Onboarding confusion", status: "VALIDATING", linkedKeyResultId: "k1", ...base },
      { id: "p2", title: "Old idea", status: "ARCHIVED", linkedKeyResultId: "k2", ...base },
    ],
    solutions: [{ id: "s1", opportunityId: "p1", title: "Checklist", status: "IN_DELIVERY", position: null }],
    assumptions: [{ id: "a1", solutionId: "s1", title: "Users read it", riskLevel: "HIGH", status: "UNTESTED", position: null }],
    experiments: [
      { id: "e1", assumptionId: "a1", title: "Fake door", status: "RUNNING", conclusion: null, ...base },
      { id: "e2", assumptionId: null, title: "Independent", status: "KILLED", conclusion: null, ...base },
    ],
    roadmapItems: [
      { id: "r1", title: "Ship checklist", horizon: "NOW", solutionId: "s1", keyResultId: null, opportunityId: "p1", experimentId: null, isBug: false, ...base },
    ],
    links: { opportunityObjective: [], solutionKeyResult: [{ solutionId: "s1", keyResultId: "k2" }] },
  } as CanvasOverview
}
