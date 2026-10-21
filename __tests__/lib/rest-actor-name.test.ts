import { beforeEach, describe, expect, it, vi } from "vitest"

const prisma = vi.hoisted(() => ({
  $transaction: vi.fn(),
  agent: { findFirst: vi.fn() },
  agentWorkspaceGrant: { findFirst: vi.fn() },
  user: { findFirst: vi.fn() },
}))
vi.mock("@/lib/db", () => ({ default: () => prisma }))

import { restActorName } from "@/lib/rest/execute"

const actor = { purpose: "AGENT", userId: "owner", agentId: "agent" } as never
const userAgent = { id: "agent", name: "Mine", ownerUserId: "owner", status: "ACTIVE" }
const sharedAgent = { id: "agent", name: "Ops", ownerUserId: null, ownerType: "WORKSPACE", ownerWorkspaceId: "ws", status: "ACTIVE" }

beforeEach(() => vi.resetAllMocks())

describe("restActorName for an agent actor", () => {
  it("names a USER-owned agent for its owner", async () => {
    prisma.agent.findFirst.mockResolvedValue(userAgent)
    expect(await restActorName(prisma as never, actor, "ws")).toBe("Mine")
  })
  it("hides a USER-owned agent's name from another user", async () => {
    prisma.agent.findFirst.mockResolvedValue({ ...userAgent, ownerUserId: "someone-else" })
    expect(await restActorName(prisma as never, actor, "ws")).toBe("Compass agent")
  })
  it("names a WORKSPACE-owned agent only where the workspace holds a live grant", async () => {
    prisma.agent.findFirst.mockResolvedValue(sharedAgent)
    prisma.agentWorkspaceGrant.findFirst.mockResolvedValue({ id: "g" })
    expect(await restActorName(prisma as never, actor, "ws")).toBe("Ops")
    expect(prisma.agentWorkspaceGrant.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { agentId: "agent", workspaceId: "ws", revokedAt: null } }))
  })
  it("hides a WORKSPACE-owned agent's name without a live grant in that workspace", async () => {
    prisma.agent.findFirst.mockResolvedValue(sharedAgent)
    prisma.agentWorkspaceGrant.findFirst.mockResolvedValue(null)
    expect(await restActorName(prisma as never, actor, "other-ws")).toBe("Compass agent")
  })
  it("hides a WORKSPACE-owned agent's name when no workspace is known", async () => {
    prisma.agent.findFirst.mockResolvedValue(sharedAgent)
    expect(await restActorName(prisma as never, actor)).toBe("Compass agent")
    expect(prisma.agentWorkspaceGrant.findFirst).not.toHaveBeenCalled()
  })
  it("falls back for a missing agent", async () => {
    prisma.agent.findFirst.mockResolvedValue(null)
    expect(await restActorName(prisma as never, actor, "ws")).toBe("Compass agent")
  })
})
