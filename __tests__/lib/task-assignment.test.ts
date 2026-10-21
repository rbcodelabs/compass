import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma } = vi.hoisted(() => ({ prisma: {
  workspaceMember: { findFirst: vi.fn(), findMany: vi.fn() },
  agent: { findFirst: vi.fn(), findMany: vi.fn() },
  agentWorkspaceGrant: { findFirst: vi.fn(), findMany: vi.fn() },
} }));
vi.mock("@/lib/db", () => ({ default: () => prisma }));
import { assignmentUpdate, eligibleTaskAssignees, parseAssigneeFilter, resolveTaskAssignees } from "@/lib/task-assignment";
import { UNASSIGNED_ASSIGNEE_FILTER } from "@/lib/task-assignee-display";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("COMPASS_AGENTS_ENABLED", "1");
  prisma.workspaceMember.findFirst.mockResolvedValue({ id: "member" });
  prisma.agent.findFirst.mockResolvedValue({ id: "agent", ownerUserId: "owner", status: "ACTIVE" });
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
    prisma.agent.findFirst.mockResolvedValue({ status: "SUSPENDED" });
    await expect(assignmentUpdate("ws", { assignee: { type: "AGENT", id: "agent" } })).rejects.toThrow("active");
    prisma.agent.findFirst.mockResolvedValue({ status: "ACTIVE", ownerUserId: "owner" });
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
  it("returns no assignee constraint when the filter is absent", () => {
    expect(parseAssigneeFilter(undefined)).toEqual({});
    expect(parseAssigneeFilter(null)).toEqual({});
    expect(parseAssigneeFilter("")).toEqual({});
  });
  it("translates the unassigned sentinel into an empty-assignee-slot predicate", () => {
    // "Unassigned" has to mean the rendered assignee slot is empty: no person,
    // no agent, and no freeform ownerName that the display logic falls back to.
    expect(parseAssigneeFilter(UNASSIGNED_ASSIGNEE_FILTER)).toEqual({
      assigneeUserId: null,
      assigneeAgentId: null,
      OR: [{ ownerName: null }, { ownerName: "" }],
    });
  });
  it("never passes the sentinel through as a uuid assignee id", () => {
    // assigneeUserId is @db.Uuid — leaking the sentinel into that filter would
    // make Postgres reject the whole query.
    const where = parseAssigneeFilter(UNASSIGNED_ASSIGNEE_FILTER) as Record<string, unknown>;
    expect(where.assigneeUserId).toBeNull();
    expect(JSON.stringify(where)).not.toContain(UNASSIGNED_ASSIGNEE_FILTER);
  });
  it("preserves unavailable agent identity in reads", async () => {
    prisma.agent.findMany.mockResolvedValue([{ id: "agent", name: "Engineer", ownerUserId: "owner", status: "SUSPENDED" }]);
    prisma.agentWorkspaceGrant.findMany.mockResolvedValue([]);
    prisma.workspaceMember.findMany.mockResolvedValue([]);
    const [task] = await resolveTaskAssignees("ws", [{ assigneeAgentId: "agent", assigneeUserId: null }]);
    expect(task.assignee).toMatchObject({ type: "AGENT", id: "agent", displayName: "Engineer", available: false });
  });
});

describe("WORKSPACE-owned agents", () => {
  const shared = { id: "shared", name: "Ops", ownerUserId: null, ownerType: "WORKSPACE", ownerWorkspaceId: "ws", status: "ACTIVE" };

  it("is assignable with an ACTIVE status and a live grant, without any owner membership", async () => {
    prisma.agent.findFirst.mockResolvedValue(shared);
    prisma.workspaceMember.findFirst.mockResolvedValue(null);
    expect(await assignmentUpdate("ws", { assignee: { type: "AGENT", id: "shared" } })).toEqual({ assigneeUserId: null, assigneeAgentId: "shared" });
    // No membership lookup at all: there is no owner user to look up.
    expect(prisma.workspaceMember.findFirst).not.toHaveBeenCalled();
  });
  it("is refused without a live grant", async () => {
    prisma.agent.findFirst.mockResolvedValue(shared);
    prisma.agentWorkspaceGrant.findFirst.mockResolvedValue(null);
    await expect(assignmentUpdate("ws", { assignee: { type: "AGENT", id: "shared" } })).rejects.toThrow("workspace");
  });
  it("is refused when suspended", async () => {
    prisma.agent.findFirst.mockResolvedValue({ ...shared, status: "SUSPENDED" });
    await expect(assignmentUpdate("ws", { assignee: { type: "AGENT", id: "shared" } })).rejects.toThrow("active");
  });
  it("a USER-owned agent whose owner is not a member is still refused (unchanged)", async () => {
    prisma.agent.findFirst.mockResolvedValue({ id: "agent", name: "Mine", ownerUserId: "owner", ownerType: "USER", status: "ACTIVE" });
    prisma.workspaceMember.findFirst.mockResolvedValue(null);
    await expect(assignmentUpdate("ws", { assignee: { type: "AGENT", id: "agent" } })).rejects.toThrow("workspace");
  });
  it("a WORKSPACE agent that names a user in ownerUserId is still not treated as user-owned", async () => {
    // The owner type is authoritative: a leftover owner_user_id must not revive owner-membership rules.
    prisma.agent.findFirst.mockResolvedValue({ ...shared, ownerUserId: "former-admin" });
    prisma.workspaceMember.findFirst.mockResolvedValue(null);
    expect(await assignmentUpdate("ws", { assignee: { type: "AGENT", id: "shared" } })).toEqual({ assigneeUserId: null, assigneeAgentId: "shared" });
  });
  it("shows a granted shared agent as available in task reads, with no owner in the workspace", async () => {
    prisma.agent.findMany.mockResolvedValue([shared]);
    prisma.agentWorkspaceGrant.findMany.mockResolvedValue([{ agentId: "shared" }]);
    prisma.workspaceMember.findMany.mockResolvedValue([]);
    const [task] = await resolveTaskAssignees("ws", [{ assigneeAgentId: "shared", assigneeUserId: null }]);
    expect(task.assignee).toMatchObject({ id: "shared", displayName: "Ops", available: true });
  });
  it("is refused in a workspace other than the one that owns it, even with a live grant", async () => {
    prisma.agent.findFirst.mockResolvedValue({ ...shared, ownerWorkspaceId: "other-ws" });
    prisma.agentWorkspaceGrant.findFirst.mockResolvedValue({ id: "grant" });
    await expect(assignmentUpdate("ws", { assignee: { type: "AGENT", id: "shared" } })).rejects.toThrow("workspace");
  });
  it("shows a foreign workspace's shared agent as unavailable in task reads and absent from the picker", async () => {
    const foreign = { ...shared, ownerWorkspaceId: "other-ws" };
    prisma.agent.findMany.mockResolvedValue([foreign]);
    prisma.agentWorkspaceGrant.findMany.mockResolvedValue([{ agentId: "shared" }]);
    prisma.workspaceMember.findMany.mockResolvedValue([]);
    const [task] = await resolveTaskAssignees("ws", [{ assigneeAgentId: "shared", assigneeUserId: null }]);
    expect(task.assignee).toMatchObject({ id: "shared", available: false });
    expect((await eligibleTaskAssignees("ws")).filter((a) => a.type === "AGENT")).toEqual([]);
  });
  it("shows an ungranted shared agent as unavailable in task reads", async () => {
    prisma.agent.findMany.mockResolvedValue([shared]);
    prisma.agentWorkspaceGrant.findMany.mockResolvedValue([]);
    prisma.workspaceMember.findMany.mockResolvedValue([]);
    const [task] = await resolveTaskAssignees("ws", [{ assigneeAgentId: "shared", assigneeUserId: null }]);
    expect(task.assignee).toMatchObject({ id: "shared", available: false });
  });
});

describe("eligibleTaskAssignees", () => {
  const member = { userId: "owner", user: { name: "Olive", email: "o@x.com" } };
  beforeEach(() => {
    prisma.workspaceMember.findMany.mockResolvedValue([member]);
  });

  it("lists a USER-owned agent only while its owner is a member, and a WORKSPACE-owned agent whenever it is granted", async () => {
    prisma.agentWorkspaceGrant.findMany.mockResolvedValue([{ agentId: "mine" }, { agentId: "orphan" }, { agentId: "shared" }]);
    prisma.agent.findMany.mockResolvedValue([
      { id: "mine", name: "Mine", ownerUserId: "owner", status: "ACTIVE" },
      { id: "orphan", name: "Orphan", ownerUserId: "departed", status: "ACTIVE" },
      { id: "shared", name: "Shared", ownerUserId: null, ownerType: "WORKSPACE", ownerWorkspaceId: "ws", status: "ACTIVE" },
    ]);
    const list = await eligibleTaskAssignees("ws");
    const agents = list.filter((a) => a.type === "AGENT");
    expect(agents.map((a) => a.id)).toEqual(["mine", "shared"]);
    expect(agents.find((a) => a.id === "mine")?.ownerName).toBe("Olive");
    expect(agents.find((a) => a.id === "shared")?.ownerName).toBeUndefined();
  });
  it("lists no agents with no live grants, or with agents disabled", async () => {
    prisma.agentWorkspaceGrant.findMany.mockResolvedValue([]);
    expect((await eligibleTaskAssignees("ws")).filter((a) => a.type === "AGENT")).toEqual([]);
    vi.stubEnv("COMPASS_AGENTS_ENABLED", "0");
    expect((await eligibleTaskAssignees("ws")).filter((a) => a.type === "AGENT")).toEqual([]);
  });
});
