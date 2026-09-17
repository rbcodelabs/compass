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
  objective: { findFirst: vi.fn() },
  keyResult: { findFirst: vi.fn() },
  opportunity: { findFirst: vi.fn() },
  solution: { findFirst: vi.fn() },
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
    | "workspaceMember"
    | "reviewRequest"
    | "decisionApplication"
    | "artifact"
    | "artifactLink"
    | "customFieldDefinition"
    | "customFieldValue"
  >;
  where: Record<string, unknown>;
}> = [
  { type: "objective", model: "objective", where: { id: ID, cycle: { workspaceId: WS } } },
  {
    type: "keyResult",
    model: "keyResult",
    where: { id: ID, objective: { cycle: { workspaceId: WS } } },
  },
  { type: "opportunity", model: "opportunity", where: { id: ID, workspaceId: WS } },
  { type: "solution", model: "solution", where: { id: ID, opportunity: { workspaceId: WS } } },
  {
    type: "assumption",
    model: "assumption",
    where: { id: ID, solution: { opportunity: { workspaceId: WS } } },
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
      models[model].findFirst.mockResolvedValue({ id: ID, evidence: [] });
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
    models.roadmapItem.findFirst.mockResolvedValue({ id: ID, workspaceId: WS });
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
      data: { ...row, pmInterviewEnabled: true, pmInterviews: [], deliveryTasks: [], linkableTasks: [], members: [] },
    });
  });

  it("also loads the delivery-tasks bundle for solution, experiment, objective, key result, and feedback", async () => {
    const cases: Array<{
      type: EntityType;
      model: Exclude<
    keyof typeof models,
    | "task"
    | "workspaceMember"
    | "reviewRequest"
    | "decisionApplication"
    | "artifact"
    | "artifactLink"
    | "customFieldDefinition"
    | "customFieldValue"
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
      models[model].findFirst.mockResolvedValue({ id: ID, evidence: [] });

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
    models[model].findFirst.mockResolvedValue({ id: ID, evidence: [] });
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
      models[model].findFirst.mockResolvedValue({ id: ID, evidence: [] });
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
