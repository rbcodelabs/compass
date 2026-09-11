import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma } = vi.hoisted(() => ({ prisma: {
  workspaceMember: { findFirst: vi.fn(), findMany: vi.fn() },
  agent: { findUnique: vi.fn(), findMany: vi.fn() },
  agentWorkspaceGrant: { findFirst: vi.fn(), findMany: vi.fn() },
} }));
vi.mock("@/lib/db", () => ({ default: () => prisma }));
import { assignmentUpdate, parseAssigneeFilter, resolveTaskAssignees } from "@/lib/task-assignment";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("COMPASS_AGENTS_ENABLED", "1");
  prisma.workspaceMember.findFirst.mockResolvedValue({ id: "member" });
  prisma.agent.findUnique.mockResolvedValue({ id: "agent", ownerUserId: "owner", status: "ACTIVE" });
  prisma.agentWorkspaceGrant.findFirst.mockResolvedValue({ id: "grant" });
});

describe("single task assignment", () => {
  it("atomically replaces a human with an agent", async () => {
    expect(await assignmentUpdate("ws", { assignee: { type: "AGENT", id: "agent" } })).toEqual({ assigneeUserId: null, assigneeAgentId: "agent" });
  });
  it("legacy human assignment clears the agent", async () => {
    expect(await assignmentUpdate("ws", { assigneeUserId: "human" })).toEqual({ assigneeUserId: "human", assigneeAgentId: null });
  });
  it("legacy null clears either kind", async () => {
    expect(await assignmentUpdate("ws", { assigneeUserId: null })).toEqual({ assigneeUserId: null, assigneeAgentId: null });
  });
  it("unrelated updates do not revalidate unavailable assignees", async () => {
    expect(await assignmentUpdate("ws", {})).toEqual({});
    expect(prisma.workspaceMember.findFirst).not.toHaveBeenCalled();
  });
  it("rejects conflicting assignment inputs", async () => {
    await expect(assignmentUpdate("ws", { assignee: null, assigneeUserId: null })).rejects.toThrow("both");
  });
  it("denies assignment when the owner left", async () => {
    prisma.workspaceMember.findFirst.mockResolvedValue(null);
    await expect(assignmentUpdate("ws", { assignee: { type: "AGENT", id: "agent" } })).rejects.toThrow("workspace");
  });
  it("denies suspended and ungranted agents", async () => {
    prisma.agent.findUnique.mockResolvedValue({ status: "SUSPENDED" });
    await expect(assignmentUpdate("ws", { assignee: { type: "AGENT", id: "agent" } })).rejects.toThrow("active");
    prisma.agent.findUnique.mockResolvedValue({ status: "ACTIVE", ownerUserId: "owner" });
    prisma.agentWorkspaceGrant.findFirst.mockResolvedValue(null);
    await expect(assignmentUpdate("ws", { assignee: { type: "AGENT", id: "agent" } })).rejects.toThrow("workspace");
  });
  it("feature-off prevents new agent assignment but allows clearing", async () => {
    vi.stubEnv("COMPASS_AGENTS_ENABLED", "0");
    await expect(assignmentUpdate("ws", { assignee: { type: "AGENT", id: "agent" } })).rejects.toThrow("enabled");
    expect(await assignmentUpdate("ws", { assignee: null })).toEqual({ assigneeUserId: null, assigneeAgentId: null });
  });
  it("parses old and typed filters without confusing agents and humans", () => {
    expect(parseAssigneeFilter("human")).toEqual({ assigneeUserId: "human" });
    expect(parseAssigneeFilter("user:human")).toEqual({ assigneeUserId: "human" });
    expect(parseAssigneeFilter("agent:agent")).toEqual({ assigneeAgentId: "agent" });
  });
  it("preserves unavailable agent identity in reads", async () => {
    prisma.agent.findMany.mockResolvedValue([{ id: "agent", name: "Engineer", ownerUserId: "owner", status: "SUSPENDED" }]);
    prisma.agentWorkspaceGrant.findMany.mockResolvedValue([]);
    prisma.workspaceMember.findMany.mockResolvedValue([]);
    const [task] = await resolveTaskAssignees("ws", [{ assigneeAgentId: "agent", assigneeUserId: null }]);
    expect(task.assignee).toMatchObject({ type: "AGENT", id: "agent", displayName: "Engineer", available: false });
  });
});
