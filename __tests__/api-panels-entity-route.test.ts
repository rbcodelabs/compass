/**
 * Unit tests for app/api/panels/entity/[type]/[id]/route.ts.
 *
 * auth(), getWorkspace(), and getEntityDetail() are mocked (same mocking
 * pattern as api-panels-discovery-rail-route.test.ts). The security-critical
 * assertion: a caller who isn't a member of the workspace (getWorkspace →
 * null) gets a 404 and the entity is NEVER looked up — this is the guard that
 * closes the cross-workspace IDOR the old per-type panel routes had.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockTrigger } = vi.hoisted(() => ({ mockDb: { task: { findFirst: vi.fn() } }, mockTrigger: vi.fn() }));
vi.mock("@/lib/db", () => ({ default: () => mockDb }));
vi.mock("@/lib/agent-task-trigger", () => ({ startRunForAssignedTask: mockTrigger }));
vi.mock("@/lib/work-item-resolve", async () => (await import("./helpers/work-item-resolve-mock")).workItemResolveMock())
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/workspace", () => ({ getWorkspace: vi.fn() }));
vi.mock("@/lib/entity-detail", async () => {
  const actual = await vi.importActual<typeof import("@/lib/entity-detail")>(
    "@/lib/entity-detail"
  );
  return { ...actual, getEntityDetail: vi.fn() };
});

vi.mock("@/lib/entity-mutations", () => ({ updateEntityField: vi.fn() }));

import { auth } from "@/auth";
import { getWorkspace } from "@/lib/workspace";
import { getEntityDetail } from "@/lib/entity-detail";
import { updateEntityField } from "@/lib/entity-mutations";
import { GET, PATCH } from "@/app/api/panels/entity/[type]/[id]/route";

const mockAuth = vi.mocked(auth);
const mockGetWorkspace = vi.mocked(getWorkspace);
const mockGetEntityDetail = vi.mocked(getEntityDetail);
const mockUpdateEntityField = vi.mocked(updateEntityField);

function call(type: string, id: string, query = "?orgSlug=acme&workspaceSlug=ws") {
  return GET(new Request(`http://localhost/api/panels/entity/${type}/${id}${query}`), {
    params: Promise.resolve({ type, id }),
  });
}

function patch(
  type: string,
  id: string,
  body: unknown,
  query = "?orgSlug=acme&workspaceSlug=ws"
) {
  return PATCH(
    new Request(`http://localhost/api/panels/entity/${type}/${id}${query}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ type, id }) }
  );
}

const signedIn = () => mockAuth.mockResolvedValue({ user: { id: "user-1" } } as never);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/panels/entity/[type]/[id]", () => {
  it("401s when there is no session", async () => {
    mockAuth.mockResolvedValue(null as never);
    const res = await call("opportunity", "opp-1");
    expect(res.status).toBe(401);
    expect(mockGetWorkspace).not.toHaveBeenCalled();
    expect(mockGetEntityDetail).not.toHaveBeenCalled();
  });

  it("400s on an unknown entity type", async () => {
    signedIn();
    const res = await call("user", "u-1");
    expect(res.status).toBe(400);
    expect(mockGetWorkspace).not.toHaveBeenCalled();
    expect(mockGetEntityDetail).not.toHaveBeenCalled();
  });

  it("400s when orgSlug/workspaceSlug are missing", async () => {
    signedIn();
    const res = await call("opportunity", "opp-1", "");
    expect(res.status).toBe(400);
    expect(mockGetEntityDetail).not.toHaveBeenCalled();
  });

  it("404s and never looks up the entity when the user isn't a workspace member (IDOR guard)", async () => {
    signedIn();
    mockGetWorkspace.mockResolvedValue(null); // not a member / no such workspace
    const res = await call("opportunity", "opp-in-another-workspace");
    expect(res.status).toBe(404);
    expect(mockGetEntityDetail).not.toHaveBeenCalled();
  });

  it("404s when the entity doesn't resolve inside the workspace", async () => {
    signedIn();
    mockGetWorkspace.mockResolvedValue({ id: "ws-1" } as never);
    mockGetEntityDetail.mockResolvedValue(null);
    const res = await call("solution", "missing");
    expect(res.status).toBe(404);
    expect(mockGetEntityDetail).toHaveBeenCalledWith("solution", "missing", "ws-1");
  });

  it("returns the detail scoped to the member's workspace on success", async () => {
    signedIn();
    mockGetWorkspace.mockResolvedValue({ id: "ws-1" } as never);
    const detail = { type: "experiment" as const, data: { id: "exp-1", title: "T" } };
    mockGetEntityDetail.mockResolvedValue(detail as never);
    const res = await call("experiment", "exp-1");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ...detail, displayId: null });
    // scoped to the workspace getWorkspace resolved, not anything client-supplied
    expect(mockGetEntityDetail).toHaveBeenCalledWith("experiment", "exp-1", "ws-1");
  });
});

describe("PATCH /api/panels/entity/[type]/[id]", () => {
  it("403s a read-only (org-wide fallback) context and never calls updateEntityField", async () => {
    signedIn();
    mockGetWorkspace.mockResolvedValue({ id: "ws-1", isReadOnly: true } as never);
    const res = await patch("opportunity", "opp-1", { field: "title", value: "New" });
    expect(res.status).toBe(403);
    expect(mockUpdateEntityField).not.toHaveBeenCalled();
  });

  it("attaches the roadmap sync result so the panel can offer Undo for an auto-added item", async () => {
    signedIn();
    mockGetWorkspace.mockResolvedValue({ id: "ws-1", isReadOnly: false } as never);
    const roadmapSync = { autoAdded: { itemId: "item-1", workspaceId: "ws-1", title: "Dash", start: null, end: null }, skipped: null, followed: 0, error: null };
    mockUpdateEntityField.mockResolvedValue({ ok: true, roadmapSync } as never);
    mockGetEntityDetail.mockResolvedValue({ type: "solution", data: { id: "sol-1" } } as never);
    const body = await (await patch("solution", "sol-1", { field: "status", value: "IN_DELIVERY" })).json();
    expect(body).toEqual({ type: "solution", data: { id: "sol-1" }, displayId: null, roadmapSync });
  });

  it("returns the plain detail when nothing reached the roadmap", async () => {
    signedIn();
    mockGetWorkspace.mockResolvedValue({ id: "ws-1", isReadOnly: false } as never);
    mockUpdateEntityField.mockResolvedValue({ ok: true } as never);
    mockGetEntityDetail.mockResolvedValue({ type: "solution", data: { id: "sol-1" } } as never);
    expect(await (await patch("solution", "sol-1", { field: "title", value: "x" })).json()).toEqual({ type: "solution", data: { id: "sol-1" }, displayId: null });
  });

  it("succeeds for a real member (isReadOnly: false)", async () => {
    signedIn();
    mockGetWorkspace.mockResolvedValue({ id: "ws-1", isReadOnly: false } as never);
    mockUpdateEntityField.mockResolvedValue({ ok: true } as never);
    mockGetEntityDetail.mockResolvedValue({ type: "opportunity", data: { id: "opp-1" } } as never);
    const res = await patch("opportunity", "opp-1", { field: "title", value: "New" });
    expect(res.status).toBe(200);
    expect(mockUpdateEntityField).toHaveBeenCalledWith(
      "opportunity",
      "opp-1",
      "ws-1",
      "title",
      "New",
      { kind: "USER", id: "user-1" }
    );
  });
  it("403s a read-only member editing customerSegment or description, writing nothing", async () => {
    signedIn();
    mockGetWorkspace.mockResolvedValue({ id: "ws-1", isReadOnly: true } as never);
    for (const field of ["customerSegment", "description"]) {
      const res = await patch("opportunity", "opp-1", { field, value: "x" });
      expect(res.status).toBe(403);
    }
    expect(mockUpdateEntityField).not.toHaveBeenCalled();
  });

  it("404s a non-member editing customerSegment before touching the entity", async () => {
    signedIn();
    mockGetWorkspace.mockResolvedValue(null as never);
    const res = await patch("opportunity", "opp-1", { field: "customerSegment", value: "SMB" });
    expect(res.status).toBe(404);
    expect(mockUpdateEntityField).not.toHaveBeenCalled();
  });

  it("passes a customerSegment edit to the workspace-scoped mutation", async () => {
    signedIn();
    mockGetWorkspace.mockResolvedValue({ id: "ws-1", isReadOnly: false } as never);
    mockUpdateEntityField.mockResolvedValue({ ok: true } as never);
    mockGetEntityDetail.mockResolvedValue({ type: "opportunity", data: { id: "opp-1" } } as never);
    const res = await patch("opportunity", "opp-1", { field: "customerSegment", value: "SMB" });
    expect(res.status).toBe(200);
    expect(mockUpdateEntityField).toHaveBeenCalledWith("opportunity", "opp-1", "ws-1", "customerSegment", "SMB", { kind: "USER", id: "user-1" });
  });

  it("surfaces a validation failure from the mutation as a 400 body", async () => {
    signedIn();
    mockGetWorkspace.mockResolvedValue({ id: "ws-1", isReadOnly: false } as never);
    mockUpdateEntityField.mockResolvedValue({ ok: false, status: 400, error: "Customer segment must be 255 characters or fewer" } as never);
    const res = await patch("opportunity", "opp-1", { field: "customerSegment", value: "x".repeat(300) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Customer segment must be 255 characters or fewer" });
  });
});

describe("PATCH a task's assignee (cloud agent runs)", () => {
  const AGENT = { type: "AGENT", id: "agent-1" };
  function arrange(previous: string | null) {
    signedIn();
    mockGetWorkspace.mockResolvedValue({ id: "ws-1", isReadOnly: false } as never);
    mockDb.task.findFirst.mockResolvedValue({ assigneeAgentId: previous });
    mockUpdateEntityField.mockResolvedValue({ ok: true } as never);
    mockGetEntityDetail.mockResolvedValue({ type: "task", data: { id: "task-1" } } as never);
  }

  it("reads the previous agent assignee BEFORE the write, then asks the trigger with the signed-in user", async () => {
    arrange("agent-0");
    mockTrigger.mockResolvedValue({ status: "started", agentName: "Triage", runId: "r1", conversationId: "c1", conversationUrl: "/acme/ws/agent?c=c1" });
    const body = await (await patch("task", "task-1", { field: "assignee", value: AGENT })).json();
    expect(mockDb.task.findFirst).toHaveBeenCalledWith({ where: { id: "task-1", workspaceId: "ws-1" }, select: { assigneeAgentId: true } });
    expect(mockDb.task.findFirst.mock.invocationCallOrder[0]).toBeLessThan(mockUpdateEntityField.mock.invocationCallOrder[0]);
    expect(mockTrigger).toHaveBeenCalledWith({ taskId: "task-1", actingUserId: "user-1", previousAssigneeAgentId: "agent-0" });
    expect(body.agentRun).toMatchObject({ status: "started", agentName: "Triage" });
  });

  it("tells the client when the run was refused, and the assignment still succeeded", async () => {
    arrange(null);
    mockTrigger.mockResolvedValue({ status: "refused", code: "AGENT_CAP_REACHED", message: "no run started: limit 5" });
    const res = await patch("task", "task-1", { field: "assignee", value: AGENT });
    expect(res.status).toBe(200);
    expect((await res.json()).agentRun).toMatchObject({ status: "refused", code: "AGENT_CAP_REACHED" });
  });

  it("says nothing when the trigger skipped (not an agent, or unchanged)", async () => {
    arrange("agent-1");
    mockTrigger.mockResolvedValue({ status: "skipped" });
    expect(await (await patch("task", "task-1", { field: "assignee", value: AGENT })).json()).toEqual({ type: "task", data: { id: "task-1" }, displayId: null });
  });

  it("does not consult the trigger for any other field or entity, nor when the write is refused", async () => {
    arrange(null);
    await patch("task", "task-1", { field: "title", value: "x" });
    await patch("opportunity", "opp-1", { field: "assignee", value: AGENT });
    mockUpdateEntityField.mockResolvedValue({ ok: false, status: 400, error: "Assignee is not in this workspace" } as never);
    expect((await patch("task", "task-1", { field: "assignee", value: AGENT })).status).toBe(400);
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("starts nothing for a read-only member or a non-member", async () => {
    signedIn();
    mockGetWorkspace.mockResolvedValue({ id: "ws-1", isReadOnly: true } as never);
    expect((await patch("task", "task-1", { field: "assignee", value: AGENT })).status).toBe(403);
    mockGetWorkspace.mockResolvedValue(null as never);
    expect((await patch("task", "task-1", { field: "assignee", value: AGENT })).status).toBe(404);
    expect(mockTrigger).not.toHaveBeenCalled();
  });
});
