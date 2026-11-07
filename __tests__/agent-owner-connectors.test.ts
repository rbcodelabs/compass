import { describe, expect, it, vi } from "vitest"
import { agentMayUseOwnerConnectors } from "@/lib/agent-ownership"
import { agentRunMayUseOwnerConnectors } from "@/lib/agent-run-identity"
import { liveGrantedWorkspaceIds } from "@/lib/agent-access"

vi.mock("@/lib/agent-access", () => ({
  agentIdentityValidForActor: vi.fn(),
  liveGrantedWorkspaceIds: vi.fn(),
}))
const grants = vi.mocked(liveGrantedWorkspaceIds)

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

function fakePrisma(run: unknown, agent: unknown, member: unknown = { id: "m1" }) {
  const findFirst = vi.fn().mockResolvedValue(run)
  const findUnique = vi.fn().mockResolvedValue(agent)
  const findMany = vi.fn().mockResolvedValue(agent ? [agent] : [])
  const memberFindFirst = vi.fn().mockResolvedValue(member)
  return { prisma: { agentRun: { findFirst }, agent: { findUnique, findFirst: findUnique, findMany }, workspaceMember: { findFirst: memberFindFirst } } as never, findFirst, memberFindFirst }
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
  it("allows a live chat run of the owner's personal agent that is still a member with a live grant", async () => {
    grants.mockResolvedValue(["w1"])
    const { prisma, memberFindFirst } = fakePrisma({ id: "run1", workspaceId: "w1" }, personal)
    expect(await agentRunMayUseOwnerConnectors(prisma, input)).toBe(true)
    expect(memberFindFirst.mock.calls[0][0].where).toEqual({ workspaceId: "w1", userId: "u1" })
  })
  it("denies once the owner is no longer a member of the run's workspace", async () => {
    grants.mockResolvedValue(["w1"])
    const { prisma } = fakePrisma({ id: "run1", workspaceId: "w1" }, personal, null)
    expect(await agentRunMayUseOwnerConnectors(prisma, input)).toBe(false)
  })
  it("denies once the agent's grant for the run's workspace is revoked", async () => {
    grants.mockResolvedValue(["other"])
    const { prisma } = fakePrisma({ id: "run1", workspaceId: "w1" }, personal)
    expect(await agentRunMayUseOwnerConnectors(prisma, input)).toBe(false)
  })
  it("denies a shared agent, a suspended agent, and a non-cloud agent even when the run row matches", async () => {
    grants.mockResolvedValue(["w1"])
    for (const agent of [shared, { ...personal, status: "SUSPENDED" }, { ...personal, kind: "EXTERNAL" }]) {
      const { prisma } = fakePrisma({ id: "run1", workspaceId: "w1" }, agent)
      expect(await agentRunMayUseOwnerConnectors(prisma, input)).toBe(false)
    }
  })
  it("denies when the lookup throws", async () => {
    const prisma = { agentRun: { findFirst: vi.fn().mockRejectedValue(new Error("db")) } } as never
    expect(await agentRunMayUseOwnerConnectors(prisma, input)).toBe(false)
  })
})
