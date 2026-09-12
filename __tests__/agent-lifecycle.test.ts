import { describe, it, expect, vi } from "vitest";
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db";
import { revokeMemberAgentGrants, deleteWorkspaceAgentData } from "@/lib/agent-lifecycle";

it("deletes conversation credentials and child receipts before conversations", async () => {
  const order: string[] = [];
  const remove = (name: string) => ({ deleteMany: vi.fn(async () => { order.push(name); return { count: 0 }; }) });
  const db = { apiKey: remove("keys"), pMInterview: { updateMany: vi.fn() }, agentMessage: remove("messages"), agentAuditLog: remove("audit"), agentConversation: remove("conversations"), agentToolCall: remove("calls"), agentWorkspaceGrant: remove("grants") };
  await deleteWorkspaceAgentData(db as unknown as AppPrismaClient, "workspace");
  expect(order.indexOf("keys")).toBeGreaterThanOrEqual(0);
  expect(order.indexOf("messages")).toBeLessThan(order.indexOf("conversations"));
  expect(order.indexOf("keys")).toBeLessThan(order.indexOf("conversations"));
});
describe("agent lifecycle", () => {
  it("revokes only the departing member's workspace grants", async () => {
    const db = { agent: { findMany: vi.fn().mockResolvedValue([{ id: "agent" }]) }, agentWorkspaceGrant: { updateMany: vi.fn() } };
    await revokeMemberAgentGrants(db as unknown as AppTransactionClient, "workspace", "owner");
    expect(db.agent.findMany).toHaveBeenCalledWith({ where: { ownerUserId: "owner" }, select: { id: true } });
    expect(db.agentWorkspaceGrant.updateMany).toHaveBeenCalledWith({ where: { workspaceId: "workspace", agentId: { in: ["agent"] }, revokedAt: null }, data: { revokedAt: expect.any(Date), updatedAt: expect.any(Date) } });
  });
  it("removes workspace records without deleting cross-workspace identities or keys", async () => {
    const db = { apiKey: { deleteMany: vi.fn() }, pMInterview: { updateMany: vi.fn() }, agentMessage: { deleteMany: vi.fn() }, agentAuditLog: { deleteMany: vi.fn() }, agentConversation: { deleteMany: vi.fn() }, agentWorkspaceGrant: { deleteMany: vi.fn() }, agentToolCall: { deleteMany: vi.fn() } };
    await deleteWorkspaceAgentData(db as unknown as AppPrismaClient, "workspace");
    expect(db.agentWorkspaceGrant.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "workspace" } });
    expect(db.agentToolCall.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "workspace" } });
  });
});
