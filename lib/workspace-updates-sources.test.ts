import { describe, expect, it, vi } from "vitest";
import type { WorkspaceUpdateEvent } from "@prisma/client";
import type { AppTransactionClient } from "./db";
import { resolveUpdateSources } from "./workspace-updates-sources";

function event(
  type: string,
  id = "source",
  groupType = type,
  groupId = id,
): WorkspaceUpdateEvent {
  return {
    id: `event-${type}-${id}`,
    workspaceId: "workspace",
    revision: 1,
    entityType: type,
    entityId: id,
    groupType,
    groupId,
    kind: "CREATED",
    actorType: "SYSTEM",
    actorId: null,
    before: null,
    after: null,
    createdAt: new Date("2026-09-24T00:00:00Z"),
  };
}
function database() {
  const models = {
    task: { findMany: vi.fn().mockResolvedValue([]) },
    opportunity: { findMany: vi.fn().mockResolvedValue([]) },
    solution: { findMany: vi.fn().mockResolvedValue([]) },
    assumption: { findMany: vi.fn().mockResolvedValue([]) },
    roadmapItem: { findMany: vi.fn().mockResolvedValue([]) },
    experiment: { findMany: vi.fn().mockResolvedValue([]) },
    reviewRequest: { findMany: vi.fn().mockResolvedValue([]) },
    doc: { findMany: vi.fn().mockResolvedValue([]) },
    comment: { findMany: vi.fn().mockResolvedValue([]) },
    evidence: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
    agent: { findMany: vi.fn().mockResolvedValue([]) },
  };
  // Only query methods used by the resolver are mocked; no database connection.
  return { models, tx: models as unknown as AppTransactionClient };
}

describe("Updates source links and visibility", () => {
  it.each([
    [
      "TASK",
      "task",
      { id: "source", title: "Task", parentTaskId: null },
      "/tasks/source",
    ],
    [
      "OPPORTUNITY",
      "opportunity",
      { id: "source", title: "Need" },
      "/discovery/source",
    ],
    [
      "SOLUTION",
      "solution",
      { id: "source", title: "Idea", opportunityId: "parent" },
      "/discovery/parent?detail=solution%3Asource",
    ],
    [
      "ASSUMPTION",
      "assumption",
      {
        id: "source",
        title: "Risk",
        solutionId: "solution",
        solution: { opportunityId: "parent" },
      },
      "/discovery/parent?detail=assumption%3Asource",
    ],
    [
      "ROADMAP_ITEM",
      "roadmapItem",
      { id: "source", title: "Plan" },
      "/roadmap?detail=roadmapItem%3Asource",
    ],
    [
      "EXPERIMENT",
      "experiment",
      { id: "source", title: "Study" },
      "/experiments/source",
    ],
    [
      "DECISION",
      "reviewRequest",
      { id: "source", currentRevision: { title: "Review" } },
      "/reviews/source",
    ],
    ["DOC", "doc", { id: "source", title: "Notes" }, "/docs/source"],
  ] as const)(
    "resolves %s to its supported source route",
    async (type, model, row, route) => {
      const { models, tx } = database();
      models[model].findMany.mockResolvedValue([row]);
      const result = await resolveUpdateSources(
        tx,
        "workspace",
        [event(type)],
        "/org/workspace",
      );
      expect(result).toHaveLength(1);
      expect(result[0].href).toBe(`/org/workspace${route}`);
    },
  );

  it("resolves evidence and root discussion through their authorized target", async () => {
    const { models, tx } = database();
    models.opportunity.findMany.mockResolvedValue([
      { id: "parent", title: "Customer need" },
    ]);
    models.evidence.findMany.mockResolvedValue([
      {
        id: "evidence",
        opportunityId: "parent",
        solutionId: null,
        assumptionId: null,
      },
    ]);
    models.comment.findMany.mockResolvedValue([
      { id: "comment", targetType: "OPPORTUNITY", targetId: "parent" },
    ]);
    const result = await resolveUpdateSources(
      tx,
      "workspace",
      [
        event("EVIDENCE", "evidence", "OPPORTUNITY", "parent"),
        event("COMMENT", "comment", "OPPORTUNITY", "parent"),
      ],
      "/org/workspace",
    );
    expect(result.map((item) => [item.href, item.groupId])).toEqual([
      ["/org/workspace/discovery/parent", "parent"],
      ["/org/workspace/discovery/parent", "parent"],
    ]);
  });

  it("suppresses deleted sources and evidence whose target is no longer accessible", async () => {
    const { models, tx } = database();
    models.evidence.findMany.mockResolvedValue([
      {
        id: "evidence",
        opportunityId: "missing",
        solutionId: null,
        assumptionId: null,
      },
    ]);
    expect(
      await resolveUpdateSources(
        tx,
        "workspace",
        [event("TASK"), event("EVIDENCE", "evidence")],
        "/org/workspace",
      ),
    ).toEqual([]);
  });

  it("suppresses child tasks with a missing parent", async () => {
    const { models, tx } = database();
    models.task.findMany
      .mockResolvedValueOnce([
        { id: "source", title: "Orphan", parentTaskId: "missing" },
      ])
      .mockResolvedValueOnce([]);
    expect(
      await resolveUpdateSources(
        tx,
        "workspace",
        [event("TASK")],
        "/org/workspace",
      ),
    ).toEqual([]);
  });

  it("scopes every direct source query and nested discovery relation to the current workspace", async () => {
    const { models, tx } = database();
    await resolveUpdateSources(
      tx,
      "workspace",
      [event("TASK")],
      "/org/workspace",
    );
    for (const model of [
      "task",
      "opportunity",
      "roadmapItem",
      "experiment",
      "reviewRequest",
      "doc",
      "comment",
      "evidence",
    ] as const) {
      expect(models[model].findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ workspaceId: "workspace" }),
        }),
      );
    }
    expect(models.solution.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          opportunity: { workspaceId: "workspace" },
        }),
      }),
    );
    expect(models.assumption.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          solution: { opportunity: { workspaceId: "workspace" } },
        }),
      }),
    );
  });
});
