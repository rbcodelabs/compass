import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db";
import { revokeMemberAgentGrants, deleteWorkspaceAgentData } from "@/lib/agent-lifecycle";
import { resetAgentRunsAvailabilityCache } from "@/lib/agent-runs";

// `deleteWorkspaceAgentData` probes `agentRunsAvailable`, which reads
// both run tables and only swallows Prisma's missing-table `P2021` — a stub that
// omits the delegates raises a TypeError instead, so every fake client here has
// to carry them.
const runDelegates = () => ({
  agentRun: { findFirst: vi.fn(async () => null), findMany: vi.fn(async (): Promise<{ id: string }[]> => []), deleteMany: vi.fn() },
  agentRunEvent: { findFirst: vi.fn(async () => null), deleteMany: vi.fn() },
});

beforeEach(() => resetAgentRunsAvailabilityCache());

it("deletes conversation credentials and child receipts before conversations", async () => {
  const order: string[] = [];
  const remove = (name: string) => ({ deleteMany: vi.fn(async () => { order.push(name); return { count: 0 }; }) });
  const db = { apiKey: remove("keys"), pMInterview: { updateMany: vi.fn() }, agentMessage: remove("messages"), agentAuditLog: remove("audit"), agentConversation: remove("conversations"), agentToolCall: remove("calls"), agentWorkspaceGrant: remove("grants"), ...runDelegates() };
  db.agentRun.findMany = vi.fn(async () => [{ id: "run" }]);
  db.agentRun.deleteMany = vi.fn(async () => { order.push("runs"); return { count: 0 }; });
  db.agentRunEvent.deleteMany = vi.fn(async () => { order.push("run-events"); return { count: 0 }; });

  await deleteWorkspaceAgentData(db as unknown as AppPrismaClient, "workspace");

  expect(order.indexOf("keys")).toBeGreaterThanOrEqual(0);
  expect(order.indexOf("messages")).toBeLessThan(order.indexOf("conversations"));
  expect(order.indexOf("keys")).toBeLessThan(order.indexOf("conversations"));
  // Runs hang off conversations, and their events off runs, so a workspace
  // deletion has to unwind that chain leaf-first.
  expect(order.indexOf("run-events")).toBeLessThan(order.indexOf("runs"));
  expect(order.indexOf("runs")).toBeLessThan(order.indexOf("conversations"));
});
describe("agent lifecycle", () => {
  it("revokes only the departing member's workspace grants", async () => {
    const db = { agent: { findMany: vi.fn().mockResolvedValue([{ id: "agent" }]) }, agentWorkspaceGrant: { updateMany: vi.fn() } };
    await revokeMemberAgentGrants(db as unknown as AppTransactionClient, "workspace", "owner");
    expect(db.agent.findMany).toHaveBeenCalledWith({ where: { ownerUserId: "owner" }, select: { id: true } });
    expect(db.agentWorkspaceGrant.updateMany).toHaveBeenCalledWith({ where: { workspaceId: "workspace", agentId: { in: ["agent"] }, revokedAt: null }, data: { revokedAt: expect.any(Date), updatedAt: expect.any(Date) } });
  });
  it("removes workspace records without deleting cross-workspace identities or keys", async () => {
    const db = { apiKey: { deleteMany: vi.fn() }, pMInterview: { updateMany: vi.fn() }, agentMessage: { deleteMany: vi.fn() }, agentAuditLog: { deleteMany: vi.fn() }, agentConversation: { deleteMany: vi.fn() }, agentWorkspaceGrant: { deleteMany: vi.fn() }, agentToolCall: { deleteMany: vi.fn() }, ...runDelegates() };
    await deleteWorkspaceAgentData(db as unknown as AppPrismaClient, "workspace");
    expect(db.agentWorkspaceGrant.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "workspace" } });
    expect(db.agentToolCall.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "workspace" } });
    expect(db.agentRun.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "workspace" } });
  });

  it("still deletes a workspace when migration 069 has not been applied", async () => {
    // A workspace deletion must not depend on the run tables existing — the code
    // ships ahead of its migration (same approach as the workspace-updates migration).
    const missingTable = Object.assign(new Error("agent_runs does not exist"), { code: "P2021" });
    const db = { apiKey: { deleteMany: vi.fn() }, pMInterview: { updateMany: vi.fn() }, agentMessage: { deleteMany: vi.fn() }, agentAuditLog: { deleteMany: vi.fn() }, agentConversation: { deleteMany: vi.fn() }, agentWorkspaceGrant: { deleteMany: vi.fn() }, agentToolCall: { deleteMany: vi.fn() }, ...runDelegates() };
    db.agentRun.findFirst = vi.fn(async () => { throw missingTable });
    db.agentRunEvent.findFirst = vi.fn(async () => { throw missingTable });

    await deleteWorkspaceAgentData(db as unknown as AppPrismaClient, "workspace");

    expect(db.agentConversation.deleteMany).toHaveBeenCalled();
    expect(db.agentRun.deleteMany).not.toHaveBeenCalled();
  });
});
