import { describe, expect, it, vi } from "vitest"
import { agentMayUseOwnerConnectors } from "@/lib/agent-ownership"
import { agentRunMayUseOwnerConnectors } from "@/lib/agent-run-identity"

const personal = { id: "ag", status: "ACTIVE", kind: "CLOUD", ownerType: "USER", ownerUserId: "u1", ownerWorkspaceId: null }
const shared = { id: "ag", status: "ACTIVE", kind: "CLOUD", ownerType: "WORKSPACE", ownerUserId: null, ownerWorkspaceId: "w1" }

describe("agentMayUseOwnerConnectors", () => {
  it("allows only an active personal agent run by its owner", () => {
    expect(agentMayUseOwnerConnectors(personal, "u1")).toBe(true)
    expect(agentMayUseOwnerConnectors(personal, "u2")).toBe(false)
    expect(agentMayUseOwnerConnectors({ ...personal, status: "SUSPENDED" }, "u1")).toBe(false)
    expect(agentMayUseOwnerConnectors(shared, "u1")).toBe(false)
    expect(agentMayUseOwnerConnectors({ ...personal, ownerUserId: null }, "u1")).toBe(false)
  })
})

function fakePrisma(run: unknown, agent: unknown) {
  const findFirst = vi.fn().mockResolvedValue(run)
  const findUnique = vi.fn().mockResolvedValue(agent)
  const findMany = vi.fn().mockResolvedValue(agent ? [agent] : [])
  return { prisma: { agentRun: { findFirst }, agent: { findUnique, findFirst: findUnique, findMany } } as never, findFirst }
}

describe("agentRunMayUseOwnerConnectors", () => {
  const input = { agentId: "ag", agentRunId: "run1", userId: "u1" }
  it("denies without a run id", async () => {
    const { prisma } = fakePrisma({ id: "run1" }, personal)
    expect(await agentRunMayUseOwnerConnectors(prisma, { ...input, agentRunId: undefined })).toBe(false)
  })
  it("only matches a CHAT run started by the same user for the same agent", async () => {
    const { prisma, findFirst } = fakePrisma(null, personal)
    expect(await agentRunMayUseOwnerConnectors(prisma, input)).toBe(false)
    expect(findFirst.mock.calls[0][0].where).toMatchObject({ id: "run1", agentId: "ag", userId: "u1", invokedByUserId: "u1", kind: "CHAT" })
  })
  it("denies when the lookup throws", async () => {
    const prisma = { agentRun: { findFirst: vi.fn().mockRejectedValue(new Error("db")) } } as never
    expect(await agentRunMayUseOwnerConnectors(prisma, input)).toBe(false)
  })
})
