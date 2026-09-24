/**
 * Unit tests for lib/entity-mutations.ts.
 *
 * Prisma is mocked. The important behaviors: field/value validation against
 * EDIT_CONFIG, and that the write is workspace-scoped — the entity is verified
 * present in the workspace (via the scoped findFirst) BEFORE any update, so a
 * cross-workspace edit can't slip through (the write-side IDOR guard).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const models = {
  objective: { findFirst: vi.fn(), update: vi.fn() },
  keyResult: { findFirst: vi.fn(), update: vi.fn() },
  opportunity: { findFirst: vi.fn(), update: vi.fn() },
  solution: { findFirst: vi.fn(), update: vi.fn() },
  feedbackItem: { findFirst: vi.fn(), update: vi.fn() },
  roadmapItem: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  task: { findFirst: vi.fn(), update: vi.fn() },
};

const database = {
  ...models,
  squad: { findFirst: vi.fn() },
  workspace: { findUnique: vi.fn() },
  portfolioCapacityReservation: { findUnique: vi.fn(), update: vi.fn() },
  portfolioCapacityPlan: { updateMany: vi.fn() },
  $transaction: vi.fn(),
};

vi.mock("@/lib/db", () => ({ default: () => database }));

// assignmentUpdate has its own dedicated unit tests in task-assignment.test.ts
// (workspace-membership / agent-grant validation). Here we only need to know
// updateTaskField's "assignee" case delegates to it and applies the result.
vi.mock("@/lib/task-assignment", () => ({ assignmentUpdate: vi.fn() }));

import { updateEntityField, EDIT_CONFIG, TITLE_MAX_LENGTH } from "@/lib/entity-mutations";
import { assignmentUpdate } from "@/lib/task-assignment";

const WS = "ws-1";

beforeEach(() => {
  vi.clearAllMocks();
  // default: entity is in the workspace
  for (const m of Object.values(models)) m.findFirst.mockResolvedValue({ id: "e1" });
  models.roadmapItem.findUnique.mockResolvedValue({ id: "e1", horizon: "NEXT", status: "ACTIVE" });
  // Default the fixture workspace to the launch workflow being on, so the
  // existing LAUNCHING/LAUNCHED tests below exercise the pre-existing
  // validation rather than the new disabled-feature gate (which gets its own
  // describe block).
  database.workspace.findUnique.mockResolvedValue({ launchWorkflowEnabled: true });
  database.portfolioCapacityReservation.findUnique.mockResolvedValue(null);
  database.$transaction.mockImplementation((fn: (value: typeof database) => unknown) => fn(database));
});

describe("EDIT_CONFIG", () => {
  it("marks keyResult as having no editable enum (no status field)", () => {
    expect(EDIT_CONFIG.keyResult.enum).toBeUndefined();
  });
  it("uses horizon (not status) as the roadmap item's enum field", () => {
    expect(EDIT_CONFIG.roadmapItem.enum?.field).toBe("horizon");
  });
});

describe("opportunity relationship edits", () => {
  it.each(["squadId", "linkedKeyResultId"])("sets and clears %s only inside the workspace", async (field) => {
    database.squad.findFirst.mockResolvedValue({ id: "target" });
    models.keyResult.findFirst.mockResolvedValue({ id: "target" });
    expect(await updateEntityField("opportunity", "e1", WS, field, "target")).toEqual({ ok: true });
    expect(models.opportunity.update).toHaveBeenCalledWith({ where: { id: "e1" }, data: { [field]: "target", updatedAt: expect.any(Date) } });
    const targetQuery = field === "squadId" ? database.squad.findFirst : models.keyResult.findFirst;
    expect(targetQuery).toHaveBeenCalledWith({ where: field === "squadId" ? { id: "target", workspaceId: WS } : { id: "target", objective: { cycle: { workspaceId: WS } } }, select: { id: true } });
    expect(await updateEntityField("opportunity", "e1", WS, field, null)).toEqual({ ok: true });
  });
  it.each(["squadId", "linkedKeyResultId"])("rejects a missing or foreign %s and invalid values", async (field) => {
    database.squad.findFirst.mockResolvedValue(null);
    models.keyResult.findFirst.mockResolvedValue(null);
    expect(await updateEntityField("opportunity", "e1", WS, field, "foreign")).toMatchObject({ ok: false, status: 404 });
    for (const value of ["", 42, {}, undefined]) expect(await updateEntityField("opportunity", "e1", WS, field, value)).toMatchObject({ ok: false, status: 400 });
    expect(models.opportunity.update).not.toHaveBeenCalled();
  });
  it.each(["squadId", "linkedKeyResultId"])("refuses %s edits on a foreign opportunity", async (field) => {
    models.opportunity.findFirst.mockResolvedValue(null);
    expect(await updateEntityField("opportunity", "foreign", WS, field, null)).toMatchObject({ ok: false, status: 404 });
    expect(models.opportunity.findFirst).toHaveBeenCalledWith({ where: { id: "foreign", workspaceId: WS }, select: { id: true } });
    expect(models.opportunity.update).not.toHaveBeenCalled();
  });
});

describe("updateEntityField — validation", () => {
  it("rejects an empty title", async () => {
    const r = await updateEntityField("objective", "e1", WS, "title", "   ");
    expect(r).toEqual({ ok: false, status: 400, error: "Title is required" });
    expect(models.objective.update).not.toHaveBeenCalled();
  });

  it("rejects an over-long title", async () => {
    const r = await updateEntityField("objective", "e1", WS, "title", "a".repeat(TITLE_MAX_LENGTH + 1));
    expect(r.ok).toBe(false);
    expect(models.objective.update).not.toHaveBeenCalled();
  });

  it("trims and saves a valid title, always setting updatedAt", async () => {
    const r = await updateEntityField("opportunity", "e1", WS, "title", "  Hello  ");
    expect(r).toEqual({ ok: true });
    const arg = models.opportunity.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "e1" });
    expect(arg.data.title).toBe("Hello");
    expect(arg.data.updatedAt).toBeInstanceOf(Date);
  });

  it("normalizes an empty description to null", async () => {
    await updateEntityField("solution", "e1", WS, "description", "   ");
    expect(models.solution.update.mock.calls[0][0].data.description).toBeNull();
  });

  it("rejects description on an entity that doesn't support it (keyResult)", async () => {
    const r = await updateEntityField("keyResult", "e1", WS, "description", "x");
    expect(r).toEqual({ ok: false, status: 400, error: "Description is not editable" });
  });

  it("rejects an invalid status enum value", async () => {
    const r = await updateEntityField("objective", "e1", WS, "status", "BOGUS");
    expect(r).toEqual({ ok: false, status: 400, error: "Invalid status" });
    expect(models.objective.update).not.toHaveBeenCalled();
  });

  it("accepts a valid status enum value", async () => {
    const r = await updateEntityField("feedback", "e1", WS, "status", "PLANNED");
    expect(r).toEqual({ ok: true });
    expect(models.feedbackItem.update.mock.calls[0][0].data.status).toBe("PLANNED");
  });

  it("accepts horizon for roadmap items but rejects 'status' there", async () => {
    expect((await updateEntityField("roadmapItem", "e1", WS, "horizon", "NEXT")).ok).toBe(true);
    const r = await updateEntityField("roadmapItem", "e1", WS, "status", "ACTIVE");
    expect(r.ok).toBe(false);
  });

  it("accepts LAUNCHED as a settable horizon", async () => {
    const r = await updateEntityField("roadmapItem", "e1", WS, "horizon", "LAUNCHED");
    expect(r.ok).toBe(true);
    expect(models.roadmapItem.update.mock.calls[0][0].data.horizon).toBe("LAUNCHED");
  });

  it("rejects a bare LAUNCHING horizon PATCH — only setLaunchTier may enter LAUNCHING (load-bearing guard)", async () => {
    const r = await updateEntityField("roadmapItem", "e1", WS, "horizon", "LAUNCHING");
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ status: 400 });
    if (!r.ok) expect(r.error).toMatch(/launch tier/i);
    // Critically: no write ever happens, so the checklist-creation transaction can't be bypassed.
    expect(models.roadmapItem.update).not.toHaveBeenCalled();
  });

  it("rejects an entirely unknown field", async () => {
    const r = await updateEntityField("opportunity", "e1", WS, "workspaceId", "other-ws");
    expect(r).toEqual({ ok: false, status: 400, error: 'Field "workspaceId" is not editable' });
    expect(models.opportunity.update).not.toHaveBeenCalled();
  });
});

describe("updateEntityField — launch horizon gated by Workspace.launchWorkflowEnabled", () => {
  it("rejects LAUNCHING with the disabled-feature message (not the 'use a launch tier' message) when the workspace's launch workflow is off", async () => {
    database.workspace.findUnique.mockResolvedValueOnce({ launchWorkflowEnabled: false });
    const r = await updateEntityField("roadmapItem", "e1", WS, "horizon", "LAUNCHING");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/launch workflow is disabled/i);
    expect(models.roadmapItem.update).not.toHaveBeenCalled();
  });

  it("rejects LAUNCHED with the disabled-feature message when the workspace's launch workflow is off", async () => {
    database.workspace.findUnique.mockResolvedValueOnce({ launchWorkflowEnabled: false });
    const r = await updateEntityField("roadmapItem", "e1", WS, "horizon", "LAUNCHED");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/launch workflow is disabled/i);
    expect(models.roadmapItem.update).not.toHaveBeenCalled();
  });

  it("still accepts LAUNCHED when the workspace's launch workflow is on", async () => {
    database.workspace.findUnique.mockResolvedValueOnce({ launchWorkflowEnabled: true });
    const r = await updateEntityField("roadmapItem", "e1", WS, "horizon", "LAUNCHED");
    expect(r.ok).toBe(true);
  });
});

describe("updateEntityField — task branch (task-specific field allowlist)", () => {
  it("rejects an empty task title", async () => {
    const r = await updateEntityField("task", "e1", WS, "title", "  ");
    expect(r).toEqual({ ok: false, status: 400, error: "Title is required" });
    expect(models.task.update).not.toHaveBeenCalled();
  });

  it("saves a valid task title, setting updatedAt", async () => {
    const r = await updateEntityField("task", "e1", WS, "title", "  New title  ");
    expect(r).toEqual({ ok: true });
    const arg = models.task.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "e1" });
    expect(arg.data.title).toBe("New title");
    expect(arg.data.updatedAt).toBeInstanceOf(Date);
  });

  it("normalizes an empty task description to null", async () => {
    await updateEntityField("task", "e1", WS, "description", "   ");
    expect(models.task.update.mock.calls[0][0].data.description).toBeNull();
  });

  it("rejects an invalid task status", async () => {
    const r = await updateEntityField("task", "e1", WS, "status", "BOGUS");
    expect(r).toEqual({ ok: false, status: 400, error: "Invalid status" });
    expect(models.task.update).not.toHaveBeenCalled();
  });

  it("accepts a valid task status", async () => {
    const r = await updateEntityField("task", "e1", WS, "status", "IN_REVIEW");
    expect(r).toEqual({ ok: true });
    expect(models.task.update.mock.calls[0][0].data.status).toBe("IN_REVIEW");
  });

  it("rejects an invalid task priority", async () => {
    const r = await updateEntityField("task", "e1", WS, "priority", "SUPER_URGENT");
    expect(r).toEqual({ ok: false, status: 400, error: "Invalid priority" });
    expect(models.task.update).not.toHaveBeenCalled();
  });

  it("accepts a valid task priority", async () => {
    const r = await updateEntityField("task", "e1", WS, "priority", "URGENT");
    expect(r).toEqual({ ok: true });
    expect(models.task.update.mock.calls[0][0].data.priority).toBe("URGENT");
  });

  it("accepts a null assigneeUserId (unassign)", async () => {
    const r = await updateEntityField("task", "e1", WS, "assigneeUserId", null);
    expect(r).toEqual({ ok: true });
    expect(models.task.update.mock.calls[0][0].data.assigneeUserId).toBeNull();
  });

  it("rejects a non-string, non-null assigneeUserId", async () => {
    const r = await updateEntityField("task", "e1", WS, "assigneeUserId", 42);
    expect(r.ok).toBe(false);
    expect(models.task.update).not.toHaveBeenCalled();
  });

  it("normalizes an empty ownerName to null", async () => {
    await updateEntityField("task", "e1", WS, "ownerName", "   ");
    expect(models.task.update.mock.calls[0][0].data.ownerName).toBeNull();
  });

  it("accepts a numeric storyPoints value", async () => {
    const r = await updateEntityField("task", "e1", WS, "storyPoints", 3.5);
    expect(r).toEqual({ ok: true });
    expect(models.task.update.mock.calls[0][0].data.storyPoints).toBe(3.5);
  });

  it("accepts a null storyPoints (clear)", async () => {
    const r = await updateEntityField("task", "e1", WS, "storyPoints", null);
    expect(r).toEqual({ ok: true });
    expect(models.task.update.mock.calls[0][0].data.storyPoints).toBeNull();
  });

  it("rejects a non-numeric storyPoints value", async () => {
    const r = await updateEntityField("task", "e1", WS, "storyPoints", "three");
    expect(r.ok).toBe(false);
    expect(models.task.update).not.toHaveBeenCalled();
  });

  it("accepts a valid ISO dueDate string, coercing to a Date", async () => {
    const r = await updateEntityField("task", "e1", WS, "dueDate", "2026-01-15");
    expect(r).toEqual({ ok: true });
    expect(models.task.update.mock.calls[0][0].data.dueDate).toBeInstanceOf(Date);
  });

  it("accepts a null dueDate (clear)", async () => {
    const r = await updateEntityField("task", "e1", WS, "dueDate", null);
    expect(r).toEqual({ ok: true });
    expect(models.task.update.mock.calls[0][0].data.dueDate).toBeNull();
  });

  it("rejects an unparsable dueDate string", async () => {
    const r = await updateEntityField("task", "e1", WS, "dueDate", "not-a-date");
    expect(r.ok).toBe(false);
    expect(models.task.update).not.toHaveBeenCalled();
  });

  it("normalizes an empty iteration to null", async () => {
    await updateEntityField("task", "e1", WS, "iteration", "");
    expect(models.task.update.mock.calls[0][0].data.iteration).toBeNull();
  });

  it("accepts a null squadId (unassign)", async () => {
    const r = await updateEntityField("task", "e1", WS, "squadId", null);
    expect(r).toEqual({ ok: true });
    expect(models.task.update.mock.calls[0][0].data.squadId).toBeNull();
  });

  it("rejects an entirely unknown task field", async () => {
    const r = await updateEntityField("task", "e1", WS, "workspaceId", "other-ws");
    expect(r).toEqual({ ok: false, status: 400, error: 'Field "workspaceId" is not editable' });
    expect(models.task.update).not.toHaveBeenCalled();
  });

  it("404s and never updates when the task isn't in the workspace", async () => {
    models.task.findFirst.mockResolvedValue(null);
    const r = await updateEntityField("task", "e1", WS, "title", "New");
    expect(r).toEqual({ ok: false, status: 404, error: "Not found" });
    expect(models.task.update).not.toHaveBeenCalled();
  });

  it("scopes the task existence check directly by workspaceId (task is workspace-owned, not parent-chain)", async () => {
    await updateEntityField("task", "t-1", WS, "title", "New");
    expect(models.task.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "t-1", workspaceId: WS } })
    );
  });
});

describe("updateEntityField — task assignee (USER/AGENT union)", () => {
  it("delegates to assignmentUpdate and writes the columns it returns", async () => {
    vi.mocked(assignmentUpdate).mockResolvedValue({ assigneeUserId: null, assigneeAgentId: "agent-1" });
    const r = await updateEntityField("task", "e1", WS, "assignee", { type: "AGENT", id: "agent-1" });
    expect(r).toEqual({ ok: true });
    expect(assignmentUpdate).toHaveBeenCalledWith(WS, { assignee: { type: "AGENT", id: "agent-1" } });
    expect(models.task.update.mock.calls[0][0].data.assigneeAgentId).toBe("agent-1");
    expect(models.task.update.mock.calls[0][0].data.assigneeUserId).toBeNull();
  });

  it("accepts a null assignee (unassign) via the union field", async () => {
    vi.mocked(assignmentUpdate).mockResolvedValue({ assigneeUserId: null, assigneeAgentId: null });
    const r = await updateEntityField("task", "e1", WS, "assignee", null);
    expect(r).toEqual({ ok: true });
    expect(assignmentUpdate).toHaveBeenCalledWith(WS, { assignee: null });
  });

  it("surfaces assignmentUpdate's validation error as a 400 and never writes", async () => {
    vi.mocked(assignmentUpdate).mockRejectedValue(new Error("Assignee is not in this workspace"));
    const r = await updateEntityField("task", "e1", WS, "assignee", { type: "USER", id: "outsider" });
    expect(r).toEqual({ ok: false, status: 400, error: "Assignee is not in this workspace" });
    expect(models.task.update).not.toHaveBeenCalled();
  });

  it("rejects a malformed assignee value without calling assignmentUpdate", async () => {
    const r = await updateEntityField("task", "e1", WS, "assignee", { type: "BOGUS", id: "x" });
    expect(r).toEqual({ ok: false, status: 400, error: "Invalid assignee" });
    expect(assignmentUpdate).not.toHaveBeenCalled();
    expect(models.task.update).not.toHaveBeenCalled();
  });
});

describe("updateEntityField — workspace scoping (write-side IDOR guard)", () => {
  it("404s and never updates when the entity isn't in the workspace", async () => {
    models.opportunity.findFirst.mockResolvedValue(null);
    const r = await updateEntityField("opportunity", "e1", WS, "title", "New");
    expect(r).toEqual({ ok: false, status: 404, error: "Not found" });
    expect(models.opportunity.update).not.toHaveBeenCalled();
  });

  it("verifies with the parent-chain scope for indirect entities before updating", async () => {
    await updateEntityField("solution", "sol-1", WS, "title", "New");
    expect(models.solution.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "sol-1", opportunity: { workspaceId: WS } } })
    );
    expect(models.solution.update).toHaveBeenCalled();
  });
});
