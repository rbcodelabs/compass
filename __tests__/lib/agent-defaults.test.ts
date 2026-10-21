import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  AgentDefaultsUnavailableError,
  agentDefaultsAvailable,
  clearUserDefaultAgent,
  clearWorkspaceDefaultAgent,
  getStoredDefaultAgentIds,
  resetAgentDefaultsAvailabilityCache,
  setUserDefaultAgent,
  setWorkspaceDefaultAgent,
} from "@/lib/agent-defaults"

/* eslint-disable @typescript-eslint/no-explicit-any */
const missingTable = () => Object.assign(new Error("The table does not exist"), { code: "P2021" })
const uniqueViolation = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" })

function fakePrisma() {
  return {
    workspaceDefaultAgent: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
    userDefaultAgent: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
  } as any
}

beforeEach(() => resetAgentDefaultsAvailabilityCache())

describe("reading stored defaults", () => {
  it("returns both ids, scoped to the user and workspace asked about", async () => {
    const prisma = fakePrisma()
    prisma.userDefaultAgent.findFirst.mockResolvedValue({ agentId: "a-user" })
    prisma.workspaceDefaultAgent.findFirst.mockResolvedValue({ agentId: "a-ws" })
    await expect(getStoredDefaultAgentIds(prisma, { userId: "u1", workspaceId: "w1" })).resolves.toEqual({ userDefaultAgentId: "a-user", workspaceDefaultAgentId: "a-ws" })
    expect(prisma.userDefaultAgent.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "u1", workspaceId: "w1" } }))
    expect(prisma.workspaceDefaultAgent.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: "w1" } }))
  })

  it("answers 'no default' while the tables are missing, and stops querying for a while", async () => {
    const prisma = fakePrisma()
    prisma.userDefaultAgent.findFirst.mockRejectedValue(missingTable())
    prisma.workspaceDefaultAgent.findFirst.mockRejectedValue(missingTable())
    await expect(getStoredDefaultAgentIds(prisma, { userId: "u1", workspaceId: "w1" })).resolves.toEqual({ userDefaultAgentId: null, workspaceDefaultAgentId: null })
    prisma.userDefaultAgent.findFirst.mockClear()
    await getStoredDefaultAgentIds(prisma, { userId: "u1", workspaceId: "w1" })
    expect(prisma.userDefaultAgent.findFirst).not.toHaveBeenCalled()
    await expect(agentDefaultsAvailable(prisma)).resolves.toBe(false)
  })

  it("rethrows a fault that is not a missing table", async () => {
    const prisma = fakePrisma()
    prisma.userDefaultAgent.findFirst.mockRejectedValue(new Error("connection reset"))
    prisma.workspaceDefaultAgent.findFirst.mockResolvedValue(null)
    await expect(getStoredDefaultAgentIds(prisma, { userId: "u1", workspaceId: "w1" })).rejects.toThrow(/connection reset/)
  })
})

describe("writing defaults", () => {
  it("creates the workspace default when none exists, recording who set it", async () => {
    const prisma = fakePrisma()
    prisma.workspaceDefaultAgent.findFirst.mockResolvedValue(null)
    await setWorkspaceDefaultAgent(prisma, { workspaceId: "w1", agentId: "a1", setByUserId: "admin" })
    expect(prisma.workspaceDefaultAgent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ workspaceId: "w1", agentId: "a1", setByUserId: "admin", updatedAt: expect.any(Date) }) }))
    expect(prisma.workspaceDefaultAgent.update).not.toHaveBeenCalled()
  })

  it("updates the existing row instead of adding a second one", async () => {
    const prisma = fakePrisma()
    prisma.workspaceDefaultAgent.findFirst.mockResolvedValue({ id: "row-1" })
    await setWorkspaceDefaultAgent(prisma, { workspaceId: "w1", agentId: "a2", setByUserId: "admin" })
    expect(prisma.workspaceDefaultAgent.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "row-1" }, data: expect.objectContaining({ agentId: "a2" }) }))
    expect(prisma.workspaceDefaultAgent.create).not.toHaveBeenCalled()
  })

  it("turns a lost unique-index race into an update, so two concurrent writers end with one row", async () => {
    const prisma = fakePrisma()
    prisma.userDefaultAgent.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "row-9" })
    prisma.userDefaultAgent.create.mockRejectedValue(uniqueViolation())
    await setUserDefaultAgent(prisma, { userId: "u1", workspaceId: "w1", agentId: "a1" })
    expect(prisma.userDefaultAgent.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "row-9" } }))
  })

  it("does not swallow a unique violation it cannot resolve", async () => {
    const prisma = fakePrisma()
    prisma.userDefaultAgent.findFirst.mockResolvedValue(null)
    prisma.userDefaultAgent.create.mockRejectedValue(uniqueViolation())
    await expect(setUserDefaultAgent(prisma, { userId: "u1", workspaceId: "w1", agentId: "a1" })).rejects.toMatchObject({ code: "P2002" })
  })

  it("clears only the targeted row", async () => {
    const prisma = fakePrisma()
    await clearWorkspaceDefaultAgent(prisma, "w1")
    await clearUserDefaultAgent(prisma, { userId: "u1", workspaceId: "w1" })
    expect(prisma.workspaceDefaultAgent.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "w1" } })
    expect(prisma.userDefaultAgent.deleteMany).toHaveBeenCalledWith({ where: { userId: "u1", workspaceId: "w1" } })
  })

  it("refuses with a clear error while the tables are missing", async () => {
    const prisma = fakePrisma()
    prisma.workspaceDefaultAgent.findFirst.mockRejectedValue(missingTable())
    await expect(setWorkspaceDefaultAgent(prisma, { workspaceId: "w1", agentId: "a1", setByUserId: "admin" })).rejects.toBeInstanceOf(AgentDefaultsUnavailableError)
    prisma.userDefaultAgent.deleteMany.mockRejectedValue(missingTable())
    await expect(clearUserDefaultAgent(prisma, { userId: "u1", workspaceId: "w1" })).rejects.toBeInstanceOf(AgentDefaultsUnavailableError)
  })
})
