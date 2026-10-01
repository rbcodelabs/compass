/**
 * Unit tests for lib/entity-detail.ts.
 *
 * Prisma is mocked (same pattern as api-panels-discovery-rail-route.test.ts).
 * The load-bearing behavior here is the WORKSPACE SCOPING baked into every
 * query's where clause — that's the access-control boundary (an entity only
 * resolves inside the caller's workspace), so each type asserts its exact
 * scoping filter, directly or via the parent chain.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const models = {
  objective: { findFirst: vi.fn(), findMany: vi.fn() },
  keyResult: { findFirst: vi.fn(), findMany: vi.fn() },
  squad: { findMany: vi.fn() },
  opportunity: { findFirst: vi.fn(), findMany: vi.fn() },
  solution: { findFirst: vi.fn(), findMany: vi.fn() },
  opportunityObjectiveLink: { findMany: vi.fn() },
  solutionKeyResultLink: { findMany: vi.fn() },
  assumption: { findFirst: vi.fn() },
  experiment: { findFirst: vi.fn() },
  roadmapItem: { findFirst: vi.fn() },
  task: { findMany: vi.fn() },
  workspaceMember: { findMany: vi.fn() },
  reviewRequest: { findFirst: vi.fn() },
  decisionApplication: { findFirst: vi.fn() },
  artifactLink: { findMany: vi.fn() },
  artifact: { findMany: vi.fn() },
  feedbackItem: { findFirst: vi.fn() },
  customFieldDefinition: { findMany: vi.fn() },
  customFieldValue: { findMany: vi.fn() },
  pMInterview: { findMany: vi.fn() },
  workspaceScoringConfig: { findUnique: vi.fn() },
};

vi.mock("@/lib/db", () => ({ default: () => models }));

import {
  getEntityDetail,
  isEntityType,
  ENTITY_TYPES,
  type EntityType,
} from "@/lib/entity-detail";

const WS = "ws-1";
const ID = "ent-1";

// Which prisma model backs each entity type, and the exact where filter that
// scopes it to a workspace (this is the IDOR defense — assert it precisely).
const CASES: Array<{
  type: EntityType;
  model: Exclude<
    keyof typeof models,
    | "task"
    | "squad"
    | "pMInterview"
    | "workspaceMember"
    | "reviewRequest"
    | "decisionApplication"
    | "artifact"
    | "artifactLink"
    | "customFieldDefinition"
    | "customFieldValue"
    | "workspaceScoringConfig"
    | "opportunityObjectiveLink"
    | "solutionKeyResultLink"
  >;
  where: Record<string, unknown>;
}> = [
  { type: "objective", model: "objective", where: { id: ID, workspaceId: WS } },
  {
    type: "keyResult",
    model: "keyResult",
    where: { id: ID, objective: { workspaceId: WS } },
  },
  { type: "opportunity", model: "opportunity", where: { id: ID, workspaceId: WS } },
  { type: "solution", model: "solution", where: { id: ID, workspaceId: WS } },
  {
    type: "assumption",
    model: "assumption",
    where: { id: ID, solution: { workspaceId: WS } },
  },
  { type: "experiment", model: "experiment", where: { id: ID, workspaceId: WS } },
  { type: "roadmapItem", model: "roadmapItem", where: { id: ID, workspaceId: WS } },
  { type: "feedback", model: "feedbackItem", where: { id: ID, workspaceId: WS } },
];

beforeEach(() => {
  vi.clearAllMocks();
  models.task.findMany.mockResolvedValue([]);
  models.workspaceMember.findMany.mockResolvedValue([]);
  models.reviewRequest.findFirst.mockResolvedValue(null);
  models.artifactLink.findMany.mockResolvedValue([]);
  models.artifact.findMany.mockResolvedValue([]);
  models.customFieldDefinition.findMany.mockResolvedValue([]);
  models.customFieldValue.findMany.mockResolvedValue([]);
  models.keyResult.findMany.mockResolvedValue([]);
  models.squad.findMany.mockResolvedValue([]);
  models.pMInterview.findMany.mockResolvedValue([]);
  // Typed links: the opportunity / solution in scope, no links by default.
  models.opportunity.findMany.mockResolvedValue([{ id: ID }]);
  models.solution.findMany.mockResolvedValue([{ id: ID }]);
  models.objective.findMany.mockResolvedValue([]);
  models.opportunityObjectiveLink.findMany.mockResolvedValue([]);
  models.solutionKeyResultLink.findMany.mockResolvedValue([]);
  // No active Solution scoring model by default — fetchSolution's Scoring
  // section gate and fetchOpportunity's nested SolutionsList ScoreBadge gate
  // both read this.
  models.workspaceScoringConfig.findUnique.mockResolvedValue(null);
});

describe("getEntityDetail — nested solutions are scoped by their own workspaceId", () => {
  it("filters the opportunity's nested solutions so a NULL or drifted row is hidden, not trusted via its parent", async () => {
    models.opportunity.findFirst.mockResolvedValue({ id: ID, evidence: [], solutions: [] });
    await getEntityDetail("opportunity", ID, WS);
    const include = (models.opportunity.findFirst.mock.calls[0][0] as { include: { solutions: { where: unknown } } }).include;
    expect(include.solutions.where).toEqual({ workspaceId: WS });
  });
});

describe("getEntityDetail — typed links ride along as additive, workspace-filtered payload", () => {
  it("returns linkedObjectives for an opportunity, reading the links and the objectives under this workspace", async () => {
    models.opportunity.findFirst.mockResolvedValue({ id: ID, evidence: [], solutions: [], linkedKeyResult: null });
    models.opportunityObjectiveLink.findMany.mockResolvedValue([{ id: "l1", opportunityId: ID, objectiveId: "obj-1", createdAt: new Date(1) }, { id: "l2", opportunityId: ID, objectiveId: "obj-foreign", createdAt: new Date(2) }]);
    models.objective.findMany.mockResolvedValue([{ id: "obj-1", title: "Grow" }]);
    const result = (await getEntityDetail("opportunity", ID, WS)) as { data: { linkedObjectives: unknown; linkedKeyResult: unknown } };
    expect(result.data.linkedObjectives).toEqual([{ id: "obj-1", title: "Grow" }]);
    // The legacy pointer is never inferred from the links.
    expect(result.data.linkedKeyResult ?? null).toBeNull();
    expect(models.opportunityObjectiveLink.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: WS, opportunityId: { in: [ID] } } }));
    expect(models.objective.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["obj-1", "obj-foreign"] }, workspaceId: WS } }));
  });

  it("returns linkedKeyResults for a solution under the same filtering", async () => {
    models.solution.findFirst.mockResolvedValue({ id: ID, evidence: [], assumptions: [], comments: [], roadmapItems: [], score: null });
    models.solutionKeyResultLink.findMany.mockResolvedValue([{ id: "s1", solutionId: ID, keyResultId: "kr-1", createdAt: new Date(1) }]);
    models.keyResult.findMany.mockResolvedValue([{ id: "kr-1", title: "KR", objectiveId: "obj-1" }]);
    const result = (await getEntityDetail("solution", ID, WS)) as { data: { linkedKeyResults: unknown } };
    expect(result.data.linkedKeyResults).toEqual([{ id: "kr-1", title: "KR", objectiveId: "obj-1" }]);
    expect(models.keyResult.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["kr-1"] }, objective: { workspaceId: WS } } }));
  });
});

describe("getEntityDetail — an opportunity's linked key result is scoped through its objective's workspaceId", () => {
  const kr = (workspaceId: string | null) => ({ id: "kr-1", title: "KR", current: 1, target: 2, unit: null, objective: { id: "o", workspaceId, title: "Objective", cycleId: "c" } });
  const run = async (workspaceId: string | null) => {
    models.opportunity.findFirst.mockResolvedValue({ id: ID, evidence: [], solutions: [], linkedKeyResult: kr(workspaceId) });
    return ((await getEntityDetail("opportunity", ID, WS)) as { data: { linkedKeyResult: unknown } }).data.linkedKeyResult;
  };
  it("shows the link when the objective is in this workspace", async () => { expect(await run(WS)).not.toBeNull(); });
  it("hides it when the objective has no workspaceId", async () => { expect(await run(null)).toBeNull(); });
  it("hides it when the objective belongs to another workspace", async () => { expect(await run("other-ws")).toBeNull(); });
});

describe("getEntityDetail — OKR nested reads are scoped by workspaceId", () => {
  it("filters a key result's supporting objectives by the workspace's own workspaceId", async () => {
    models.keyResult.findFirst.mockResolvedValue({ id: ID });
    await getEntityDetail("keyResult", ID, WS);
    const include = (models.keyResult.findFirst.mock.calls[0][0] as { include: { supportingObjectives: { where: unknown } } }).include;
    expect(include.supportingObjectives.where).toEqual({ workspaceId: WS });
  });

  it("hides an objective's parent KR when that KR's objective is in another workspace or has no workspaceId", async () => {
    const parent = (workspaceId: string | null) => ({ id: "pkr", title: "P", objective: { id: "po", workspaceId, title: "PO", cycle: { id: "c", title: "C", status: "ACTIVE" } } });
    models.objective.findFirst.mockResolvedValueOnce({ id: ID, parentKeyResult: parent(WS) });
    expect(((await getEntityDetail("objective", ID, WS)) as { data: { parentKeyResult: unknown } }).data.parentKeyResult).not.toBeNull();
    models.objective.findFirst.mockResolvedValueOnce({ id: ID, parentKeyResult: parent("other-ws") });
    expect(((await getEntityDetail("objective", ID, WS)) as { data: { parentKeyResult: unknown } }).data.parentKeyResult).toBeNull();
    models.objective.findFirst.mockResolvedValueOnce({ id: ID, parentKeyResult: parent(null) });
    expect(((await getEntityDetail("objective", ID, WS)) as { data: { parentKeyResult: unknown } }).data.parentKeyResult).toBeNull();
  });
});

describe("isEntityType", () => {
  it("accepts every known entity type", () => {
    for (const t of ENTITY_TYPES) expect(isEntityType(t)).toBe(true);
  });
  it("rejects unknown strings", () => {
    for (const t of ["", "user", "Objective", "workspace", "opportunit"]) {
      expect(isEntityType(t)).toBe(false);
    }
  });
});

// The row stubs below carry `evidence: []` because the opportunity, solution
// and assumption fetchers `include` that relation and then resolve its research
// provenance (ADR-0012 step 6a, lib/evidence-provenance.ts). Real Prisma always
// returns the included relation; a stub that omits it models a query these
// fetchers never make.
describe("getEntityDetail — workspace scoping", () => {
  for (const { type, model, where } of CASES) {
    it(`scopes ${type} to the workspace (directly or via parent chain)`, async () => {
      // workspace/launchWorkflowEnabled is only consumed by fetchRoadmapItem
      // (flattened onto the panel payload, see lib/entity-detail.ts) but is
      // harmless to include for every type in this generic matrix.
      models[model].findFirst.mockResolvedValue({ id: ID, evidence: [], workspace: { launchWorkflowEnabled: true } });
      await getEntityDetail(type, ID, WS);
      expect(models[model].findFirst).toHaveBeenCalledTimes(1);
      expect(models[model].findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where })
      );
    });

    it(`never queries ${type} without the workspace filter`, async () => {
      models[model].findFirst.mockResolvedValue(null);
      await getEntityDetail(type, ID, WS);
      const arg = models[model].findFirst.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      // The id alone must never be the whole filter — some workspace
      // constraint (own field or a relation) must always be present.
      const keys = Object.keys(arg.where);
      expect(keys).toContain("id");
      expect(keys.length).toBeGreaterThan(1);
    });
  }
});

describe("getEntityDetail — return shape", () => {
  it("preserves agent conversation identity in opportunity interview history", async () => {
    models.opportunity.findFirst.mockResolvedValue({ id: ID, evidence: [] });
    await getEntityDetail("opportunity", ID, WS);
    expect(models.pMInterview.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: WS, targetType: "OPPORTUNITY", targetId: ID }, select: expect.objectContaining({ agentConversationId: true }) }));
  });
  it("loads the shared opportunity editing options and full solution tree within its workspace", async () => {
    models.opportunity.findFirst.mockResolvedValue({ id: ID, evidence: [], score: null });
    models.squad.findMany.mockResolvedValue([{ id: "squad", name: "Team", color: "blue" }]);
    models.keyResult.findMany.mockResolvedValue([{ id: "kr", title: "Outcome", objective: { title: "Objective" } }]);
    const result = await getEntityDetail("opportunity", ID, WS);
    expect(result?.data).toMatchObject({ squads: [{ id: "squad" }], availableKeyResults: [{ id: "kr", objectiveTitle: "Objective" }], customFields: [] });
    expect(models.squad.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: WS } }));
    expect(models.keyResult.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { objective: { workspaceId: WS } } }));
    expect(models.opportunity.findFirst).toHaveBeenCalledWith(expect.objectContaining({ include: expect.objectContaining({ solutions: expect.objectContaining({ include: expect.objectContaining({ assumptions: expect.objectContaining({ include: expect.objectContaining({ experiments: expect.any(Object) }) }) }) }) }) }));
  });
  it("only loads linked feedback in the opportunity workspace, newest first with a stable tie break", async () => {
    models.opportunity.findFirst.mockResolvedValue({ id: ID, evidence: [] });
    await getEntityDetail("opportunity", ID, WS);
    expect(models.opportunity.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        feedback: {
          where: { workspaceId: WS },
          select: { id: true, title: true, type: true, status: true },
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        },
      }),
    }));
  });

  it("returns active roadmap delivery tasks and linkable workspace tasks in deterministic delivery order", async () => {
    models.roadmapItem.findFirst.mockResolvedValue({ id: ID, workspaceId: WS, workspace: { launchWorkflowEnabled: true } });
    models.task.findMany
      .mockResolvedValueOnce([{ id: "blocked", status: "BLOCKED" }])
      .mockResolvedValueOnce([{ id: "candidate", title: "Candidate" }]);
    models.workspaceMember.findMany.mockResolvedValue([]);

    const result = await getEntityDetail("roadmapItem", ID, WS);

    expect(models.task.findMany).toHaveBeenNthCalledWith(1, {
      where: {
        workspaceId: WS,
        status: { not: "CANCELLED" },
        links: { some: { linkedType: "ROADMAP_ITEM", linkedId: ID } },
      },
      select: expect.objectContaining({ id: true, title: true, status: true, priority: true }),
      orderBy: [{ status: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    expect(models.task.findMany).toHaveBeenNthCalledWith(2, {
      where: {
        workspaceId: WS,
        status: { not: "CANCELLED" },
        links: { none: { linkedType: "ROADMAP_ITEM", linkedId: ID } },
      },
      select: { id: true, title: true },
      orderBy: [{ title: "asc" }, { id: "asc" }],
    });
    expect(result).toEqual({
      type: "roadmapItem",
      data: expect.objectContaining({
        deliveryTasks: [{ id: "blocked", status: "BLOCKED", assignee: null }],
        linkableTasks: [{ id: "candidate", title: "Candidate" }],
        members: [],
      }),
    });
  });

  it("wraps a hit as { type, data }", async () => {
    const row = { id: ID, title: "An opportunity", evidence: [] };
    models.opportunity.findFirst.mockResolvedValue(row);
    const result = await getEntityDetail("opportunity", ID, WS);
    expect(result).toEqual({
      type: "opportunity",
      data: { ...row, pmInterviewEnabled: true, pmInterviews: [], deliveryTasks: [], linkableTasks: [], members: [], squads: [], availableKeyResults: [], customFields: [], existingScore: null, solutions: [], hasActiveSolutionScoringModel: false, linkedObjectives: [] },
    });
  });

  it("also loads the delivery-tasks bundle for solution, experiment, objective, key result, and feedback", async () => {
    const cases: Array<{
      type: EntityType;
      model: Exclude<
    keyof typeof models,
    | "task"
    | "squad"
    | "pMInterview"
    | "workspaceMember"
    | "reviewRequest"
    | "decisionApplication"
    | "artifact"
    | "artifactLink"
    | "customFieldDefinition"
    | "customFieldValue"
    | "workspaceScoringConfig"
    | "opportunityObjectiveLink"
    | "solutionKeyResultLink"
  >;
      linkedType: string;
    }> = [
      { type: "solution", model: "solution", linkedType: "SOLUTION" },
      { type: "experiment", model: "experiment", linkedType: "EXPERIMENT" },
      { type: "objective", model: "objective", linkedType: "OBJECTIVE" },
      { type: "keyResult", model: "keyResult", linkedType: "KEY_RESULT" },
      { type: "feedback", model: "feedbackItem", linkedType: "FEEDBACK_ITEM" },
    ];
    for (const { type, model, linkedType } of cases) {
      vi.clearAllMocks();
      models.task.findMany.mockResolvedValue([]);
      models.workspaceMember.findMany.mockResolvedValue([]);
      models.artifactLink.findMany.mockResolvedValue([]);
      models.artifact.findMany.mockResolvedValue([]);
      // workspace/launchWorkflowEnabled is only consumed by fetchRoadmapItem
      // (flattened onto the panel payload, see lib/entity-detail.ts) but is
      // harmless to include for every type in this generic matrix.
      models[model].findFirst.mockResolvedValue({ id: ID, evidence: [], workspace: { launchWorkflowEnabled: true } });

      const result = await getEntityDetail(type, ID, WS);

      expect(result).toEqual({
        type,
        data: expect.objectContaining({ deliveryTasks: [], linkableTasks: [], members: [] }),
      });
      expect(models.task.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
        where: expect.objectContaining({ links: { some: { linkedType, linkedId: ID } } }),
      }));
    }
  });

  it("returns null when the entity isn't in the workspace (findFirst miss)", async () => {
    models.solution.findFirst.mockResolvedValue(null);
    const result = await getEntityDetail("solution", ID, WS);
    expect(result).toBeNull();
  });

  // RoadmapItem and Solution have no detail route, so their panels are the only
  // place their tags can be edited — which means the detail payload is the only
  // thing that can carry them. Without this the workspace's shipped
  // ROADMAP_ITEM/SOLUTION tag filters have nothing to match against.
  it.each([
    { type: "roadmapItem" as const, model: "roadmapItem" as const, objectType: "ROADMAP_ITEM" },
    { type: "solution" as const, model: "solution" as const, objectType: "SOLUTION" },
  ])("loads $objectType custom fields with their current values", async ({ type, model, objectType }) => {
    models[model].findFirst.mockResolvedValue({ id: ID, evidence: [], workspace: { launchWorkflowEnabled: true } });
    models.customFieldDefinition.findMany.mockResolvedValue([
      {
        id: "field-area",
        name: "Product Area",
        fieldType: "MULTI_SELECT",
        objectType,
        options: [{ label: "ZZ Alpha", value: "zz_alpha" }],
        sharedOptionSetId: null,
        required: false,
        order: 0,
        sharedOptionSet: null,
      },
    ]);
    models.customFieldValue.findMany.mockResolvedValue([
      { fieldId: "field-area", value: ["zz_alpha"] },
    ]);

    const result = await getEntityDetail(type, ID, WS);

    expect(models.customFieldDefinition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WS, objectType } })
    );
    expect(models.customFieldValue.findMany).toHaveBeenCalledWith({
      where: { fieldId: { in: ["field-area"] }, objectId: ID },
    });
    expect(result).toMatchObject({
      type,
      data: {
        customFields: [
          expect.objectContaining({ id: "field-area", name: "Product Area", currentValue: ["zz_alpha"] }),
        ],
      },
    });
  });

  it("dispatches each type to only its own model", async () => {
    for (const { type, model } of CASES) {
      vi.clearAllMocks();
      // workspace/launchWorkflowEnabled is only consumed by fetchRoadmapItem
      // (flattened onto the panel payload, see lib/entity-detail.ts) but is
      // harmless to include for every type in this generic matrix.
      models[model].findFirst.mockResolvedValue({ id: ID, evidence: [], workspace: { launchWorkflowEnabled: true } });
      const result = await getEntityDetail(type, ID, WS);
      expect(result).toEqual({ type, data: expect.objectContaining({ id: ID }) });
      // no other model was touched
      for (const other of CASES) {
        if (other.model === model) continue;
        expect(models[other.model].findFirst).not.toHaveBeenCalled();
      }
    }
  });
});
