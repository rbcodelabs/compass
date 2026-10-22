import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockAuth = vi.fn()
vi.mock("@/auth", () => ({ auth: () => mockAuth() }))
const mockPrisma = { workspace: { findFirst: vi.fn() } }
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))
const identity = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock("@/lib/agent-run-identity", () => ({ listRunnableAgents: identity.list }))

import { GET } from "@/app/api/agent/choices/route"

const get = (query: string) => GET(new Request(`https://compass.test/api/agent/choices?${query}`))

afterEach(() => { delete process.env.COMPASS_CLOUD_AGENT_MODELS; delete process.env.AGENT_MODEL_PROVIDER; delete process.env.AGENT_MODEL_ID; delete process.env.AGENT_HARNESS })

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ user: { id: "u1" } })
  mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
  identity.list.mockResolvedValue({ agents: [{ id: "a1", name: "Triage", ownerType: "WORKSPACE", instructions: "SECRET", model: "claude-opus-9" }, { id: "a2", name: "Mine", ownerType: "USER", model: "gpt-5; bad" }], defaultAgentId: "a1" })
})

describe("GET /api/agent/choices", () => {
  it("answers 401 without a session", async () => {
    mockAuth.mockResolvedValue(null)
    expect((await get("workspaceId=ws-1")).status).toBe(401)
  })

  it("returns names, ownership and the default only: never instructions", async () => {
    const body = await (await get("workspaceId=ws-1")).json()
    expect(body).toMatchObject({ agents: [{ id: "a1", name: "Triage", shared: true, model: "claude-opus-9" }, { id: "a2", name: "Mine", shared: false, model: null }], defaultAgentId: "a1" })
    expect(JSON.stringify(body)).not.toContain("SECRET")
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
    expect(await (await get("workspaceId=ws-9")).json()).toEqual({ agents: [], defaultAgentId: null, models: [], deploymentModel: null, modelLabels: {} })
    expect(await (await get("")).json()).toEqual({ agents: [], defaultAgentId: null, models: [], deploymentModel: null, modelLabels: {} })
    expect(identity.list).not.toHaveBeenCalled()
  })

  describe("models", () => {
    it("offers the allowed models the Claude harness can serve, the deployment default, and a label for each model in use", async () => {
      process.env.COMPASS_CLOUD_AGENT_MODELS = "claude-opus-9"
      const body = await (await get("workspaceId=ws-1")).json()
      expect(body.models).toEqual([{ value: "claude-sonnet-5", label: "Claude Sonnet 5" }, { value: "claude-opus-9", label: "claude-opus-9" }])
      expect(body.deploymentModel).toBe("claude-sonnet-5")
      expect(body.modelLabels).toMatchObject({ "claude-sonnet-5": "Claude Sonnet 5", "claude-opus-9": "claude-opus-9" })
    })

    it("returns no models to a non-member, even when the deployment offers several", async () => {
      process.env.COMPASS_CLOUD_AGENT_MODELS = "claude-opus-9"
      mockPrisma.workspace.findFirst.mockResolvedValue(null)
      const body = await (await get("workspaceId=ws-9")).json()
      expect(body).toEqual({ agents: [], defaultAgentId: null, models: [], deploymentModel: null, modelLabels: {} })
    })

    it("follows AGENT_MODEL_ID for the default", async () => {
      process.env.AGENT_MODEL_ID = "claude-opus-9"
      expect((await (await get("workspaceId=ws-1")).json()).deploymentModel).toBe("claude-opus-9")
    })

    it("offers gateway ids on the opencode harness", async () => {
      process.env.AGENT_HARNESS = "opencode"
      const body = await (await get("workspaceId=ws-1")).json()
      expect(body.models.map((m: { value: string }) => m.value)).toEqual(["anthropic/claude-sonnet-5.5"])
      expect(body.deploymentModel).toBe("anthropic/claude-sonnet-5.5")
    })

    it("offers nothing on Bedrock, and an agent's Anthropic-API model is not claimed for it", async () => {
      process.env.AGENT_MODEL_PROVIDER = "bedrock"
      const body = await (await get("workspaceId=ws-1")).json()
      expect(body.models).toEqual([])
      expect(body.agents[0].model).toBeNull()
      expect(body.deploymentModel).toBe("global.anthropic.claude-sonnet-5-5")
    })
  })
})
