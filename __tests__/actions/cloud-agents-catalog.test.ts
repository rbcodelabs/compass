import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/* eslint-disable @typescript-eslint/no-explicit-any */
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  admin: vi.fn(),
  liveGrants: vi.fn(),
  agent: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  agentWorkspaceGrant: { create: vi.fn() },
  workspace: { findFirst: vi.fn() },
  $transaction: vi.fn(),
}))
vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("@/lib/db", () => ({ default: () => mocks }))
vi.mock("@/lib/permissions", () => ({ resolveWorkspaceAdmin: mocks.admin }))
vi.mock("@/lib/agent-access", () => ({ liveGrantedWorkspaceIds: mocks.liveGrants }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

import { createCloudAgent, updateCloudAgent } from "@/app/settings/agents/actions"

const catalog = { data: [{ id: "openai/gpt-5", name: "GPT-5", type: "language", tags: ["tool-use"], owned_by: "openai" }] }
const base = { orgSlug: "acme", workspaceSlug: "home", name: "Triage", model: "openai/gpt-5", ownerType: "USER" as const }
const personalAgent = { id: "a-personal", ownerUserId: "member", ownerType: "USER", ownerWorkspaceId: null, kind: "CLOUD", status: "ACTIVE", name: "Mine", model: "openai/gpt-5", invokePolicy: "OWNER" }
const stubGateway = (ok: boolean) => vi.stubGlobal("fetch", vi.fn(async () => (ok ? new Response(JSON.stringify(catalog), { status: 200 }) : Promise.reject(new Error("down")))))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: "member" } })
  mocks.$transaction.mockImplementation((operation: any) => operation(mocks))
  mocks.agent.create.mockResolvedValue({ id: "new-agent" })
  mocks.liveGrants.mockResolvedValue(["ws-1"])
  mocks.workspace.findFirst.mockImplementation(async ({ where }: any) => (where.slug ? { id: "ws-1" } : { members: [{ role: "MEMBER" }], organization: { members: [] } }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.AGENT_HARNESS
})

describe("agent actions and the gateway catalog", () => {
  it("creates an agent on a catalog model on the opencode harness when the catalog lists it", async () => {
    process.env.AGENT_HARNESS = "opencode"
    stubGateway(true)
    await createCloudAgent(base)
    expect(mocks.agent.create.mock.calls[0][0].data.model).toBe("openai/gpt-5")
  })

  it("refuses a catalog model on the Claude harness", async () => {
    stubGateway(true)
    await expect(createCloudAgent(base)).rejects.toThrow(/available models/)
    expect(mocks.agent.create).not.toHaveBeenCalled()
  })

  it("refuses an id the catalog does not list, even on opencode", async () => {
    process.env.AGENT_HARNESS = "opencode"
    stubGateway(true)
    await expect(createCloudAgent({ ...base, model: "openai/not-real" })).rejects.toThrow(/available models/)
    expect(mocks.agent.create).not.toHaveBeenCalled()
  })

  it("keeps an already stored catalog model untouched when the gateway is down, and still refuses a new unlisted one", async () => {
    process.env.AGENT_HARNESS = "opencode"
    mocks.agent.findFirst.mockResolvedValue(personalAgent)
    stubGateway(false)
    await updateCloudAgent("a-personal", { name: "Renamed", model: "openai/gpt-5" })
    expect(mocks.agent.update.mock.calls[0][0].data).not.toHaveProperty("model")
    await expect(updateCloudAgent("a-personal", { model: "openai/other" })).rejects.toThrow(/available models/)
  })

  it("updates to a catalog model when the catalog lists it", async () => {
    process.env.AGENT_HARNESS = "opencode"
    mocks.agent.findFirst.mockResolvedValue({ ...personalAgent, model: null })
    stubGateway(true)
    await updateCloudAgent("a-personal", { model: "openai/gpt-5" })
    expect(mocks.agent.update.mock.calls[0][0].data.model).toBe("openai/gpt-5")
  })

  it("lets the model be cleared to the system default with the gateway down", async () => {
    process.env.AGENT_HARNESS = "opencode"
    mocks.agent.findFirst.mockResolvedValue(personalAgent)
    stubGateway(false)
    await updateCloudAgent("a-personal", { model: "" })
    expect(mocks.agent.update.mock.calls[0][0].data.model).toBeNull()
  })
})
