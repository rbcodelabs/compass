import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { revokeMemberAgentGrants, deleteWorkspaceAgentData } from "@/lib/agent-lifecycle";
describe("agent lifecycle", () => {
  it("revokes only the departing member's workspace grants", async () => {
    const db = { agent: { findMany: vi.fn().mockResolvedValue([{ id: "agent" }]) }, agentWorkspaceGrant: { updateMany: vi.fn() } };
    await revokeMemberAgentGrants(db as unknown as PrismaClient, "workspace", "owner");
    expect(db.agent.findMany).toHaveBeenCalledWith({ where: { ownerUserId: "owner" }, select: { id: true } });
    expect(db.agentWorkspaceGrant.updateMany).toHaveBeenCalledWith({ where: { workspaceId: "workspace", agentId: { in: ["agent"] }, revokedAt: null }, data: { revokedAt: expect.any(Date), updatedAt: expect.any(Date) } });
  });
  it("removes workspace records without deleting cross-workspace identities or keys", async () => {
    const db = { agentWorkspaceGrant: { deleteMany: vi.fn() }, agentToolCall: { deleteMany: vi.fn() } };
    await deleteWorkspaceAgentData(db as unknown as PrismaClient, "workspace");
    expect(db.agentWorkspaceGrant.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "workspace" } });
    expect(db.agentToolCall.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "workspace" } });
  });
});
