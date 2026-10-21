import { beforeEach, describe, expect, it, vi } from "vitest"

const mockAuth = vi.fn()
vi.mock("@/auth", () => ({ auth: () => mockAuth() }))
const mockPrisma = { workspace: { findFirst: vi.fn() } }
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))
const identity = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock("@/lib/agent-run-identity", () => ({ listRunnableAgents: identity.list }))

import { GET } from "@/app/api/agent/choices/route"

const get = (query: string) => GET(new Request(`https://compass.test/api/agent/choices?${query}`))

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ user: { id: "u1" } })
  mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
  identity.list.mockResolvedValue({ agents: [{ id: "a1", name: "Triage", ownerType: "WORKSPACE", instructions: "SECRET" }, { id: "a2", name: "Mine", ownerType: "USER" }], defaultAgentId: "a1" })
})

describe("GET /api/agent/choices", () => {
  it("answers 401 without a session", async () => {
    mockAuth.mockResolvedValue(null)
    expect((await get("workspaceId=ws-1")).status).toBe(401)
  })

  it("returns names, ownership and the default only: never instructions", async () => {
    const body = await (await get("workspaceId=ws-1")).json()
    expect(body).toEqual({ agents: [{ id: "a1", name: "Triage", shared: true }, { id: "a2", name: "Mine", shared: false }], defaultAgentId: "a1" })
    expect(identity.list).toHaveBeenCalledWith(mockPrisma, { userId: "u1", workspaceId: "ws-1" })
  })

  it("scopes the workspace lookup to the caller's memberships, by id or by slugs", async () => {
    await get("workspaceId=ws-1")
    expect(mockPrisma.workspace.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: "ws-1", members: { some: { userId: "u1" } } } }))
    await get("orgSlug=acme&workspaceSlug=home")
    expect(mockPrisma.workspace.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { slug: "home", organization: { slug: "acme" }, members: { some: { userId: "u1" } } } }))
  })

  it("gives a non-member, or no workspace at all, the same empty answer without listing anything", async () => {
    mockPrisma.workspace.findFirst.mockResolvedValue(null)
    expect(await (await get("workspaceId=ws-9")).json()).toEqual({ agents: [], defaultAgentId: null })
    expect(await (await get("")).json()).toEqual({ agents: [], defaultAgentId: null })
    expect(identity.list).not.toHaveBeenCalled()
  })
})
