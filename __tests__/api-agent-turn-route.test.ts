/**
 * Guard tests for the agent turn route (app/api/agent/turn/route.ts).
 *
 * Covers the security-critical early returns before any sandbox is booted:
 * session required, input validation, workspace-membership authorization,
 * conversation ownership, and runtime prerequisites. The streamed happy path
 * (real sandbox boot + agent run) is verified end-to-end against a deploy.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { normalizeCapabilityPack } from "@/lib/capability-pack"

const mockAuth = vi.fn()
vi.mock("@/auth", () => ({ auth: () => mockAuth() }))

const mockPrisma = {
  workspace: { findFirst: vi.fn() },
  agentConversation: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  agentMessage: { create: vi.fn(), findMany: vi.fn() },
  agentAuditLog: { createMany: vi.fn() },
  workspaceCapabilityPack: { findMany: vi.fn() },
  // ADR 0019: materializeDocTree reads the doc tree via lib/doc-fs.ts before
  // every turn. Empty by default -- these guard tests aren't about docs.
  doc: { findMany: vi.fn(), findUnique: vi.fn() },
}
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

const mockGetGoldenSnapshotId = vi.fn()
vi.mock("@/lib/agent-runtime-config", () => ({ getGoldenSnapshotId: () => mockGetGoldenSnapshotId() }))
// Sandbox + key modules should never be reached in guard tests; stub them safely.
const mockBootSandbox = vi.fn()
const mockMintKey = vi.fn()
const mockRevokeKey = vi.fn()
vi.mock("@/lib/agent-sandbox", () => ({ bootSandboxFromSnapshot: (...args: unknown[]) => mockBootSandbox(...args) }))
vi.mock("@/lib/agent-mcp-key", () => ({ mintAgentMcpKey: (...args: unknown[]) => mockMintKey(...args), revokeAgentMcpKey: (...args: unknown[]) => mockRevokeKey(...args) }))
const mockPreparePacks = vi.fn()
vi.mock("@/lib/capability-pack-runtime", () => ({ prepareCapabilityPacksForTurn: (...args: unknown[]) => mockPreparePacks(...args) }))
const mockPackStorage = vi.fn()
vi.mock("@/lib/artifact-storage", () => ({ getCapabilityPackArtifactStorage: () => mockPackStorage() }))

const mockCheckLimit = vi.fn()
vi.mock("@/lib/agent-limits", () => ({ checkAgentUsageLimit: () => mockCheckLimit() }))

const mockResolveAgentHandoffContext = vi.fn()
vi.mock("@/lib/agent-context", () => ({ resolveAgentHandoffContext: (...args: unknown[]) => mockResolveAgentHandoffContext(...args) }))

// ADR-0018. Mocked at the store rather than at prisma because what matters here
// is what the route does with the slugs, and `connectorDefinition` is left real
// so the catalog itself is part of the assertion.
const mockListConnectedSlugs = vi.fn()
vi.mock("@/lib/mcp-connectors/store", () => ({
  listConnectedSlugs: (...args: unknown[]) => mockListConnectedSlugs(...args),
}))

import { POST } from "@/app/api/agent/turn/route"

function req(body: unknown): NextRequest {
  return new NextRequest("https://compass.rbcodelabs.com/api/agent/turn", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
}

const SESSION = { user: { id: "user-1" } }

beforeEach(() => {
  vi.clearAllMocks()
  mockPackStorage.mockReturnValue({})
  process.env.ANTHROPIC_API_KEY = "sk-ant-test"
  mockAuth.mockResolvedValue(SESSION)
  mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
  mockPrisma.agentConversation.findFirst.mockResolvedValue(null)
  mockPrisma.workspaceCapabilityPack.findMany.mockResolvedValue([])
  mockGetGoldenSnapshotId.mockResolvedValue("snap_abc")
  mockCheckLimit.mockResolvedValue({ allowed: true })
  mockMintKey.mockResolvedValue({ token: "token", apiKeyId: "key-1" })
  mockPreparePacks.mockResolvedValue({ files: [], pluginPaths: [], skillIds: [], provenanceJson: "[]", systemPromptAppendices: [] })
  mockResolveAgentHandoffContext.mockResolvedValue(null)
  mockListConnectedSlugs.mockResolvedValue([])
  mockPrisma.doc.findMany.mockResolvedValue([])
})

describe("agent turn route — guards", () => {
  it.each(["usage", "snapshot"])("makes a pending handoff retryable when the %s prerequisite throws", async cause => {
    const error = new Error("prerequisite lookup failed")
    mockPrisma.agentConversation.findFirst.mockResolvedValue({ id: "c-1", interviewProcessingJson: JSON.stringify({ status: "PENDING", interviewId: "interview" }) })
    mockPrisma.agentConversation.updateMany.mockResolvedValue({ count: 1 })
    if (cause === "usage") mockCheckLimit.mockRejectedValueOnce(error)
    else mockGetGoldenSnapshotId.mockRejectedValueOnce(error)
    await expect(POST(req({ workspaceId: "ws-1", conversationId: "c-1", message: "Finish interview" }))).rejects.toBe(error)
    expect(mockPrisma.agentConversation.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "c-1", userId: "user-1", workspaceId: "ws-1" }) }))
    expect(JSON.parse(mockPrisma.agentConversation.updateMany.mock.calls[0][0].data.interviewProcessingJson).status).toBe("FAILED")
    expect(mockMintKey).not.toHaveBeenCalled()
  })
  it.each(["usage", "runtime"])("persists pending interview %s preflight failure so retry is explicit", async cause => {
    mockPrisma.agentConversation.findFirst.mockResolvedValue({ id: "c-1", interviewProcessingJson: JSON.stringify({ status: "PENDING", interviewId: "interview" }) })
    mockPrisma.agentConversation.updateMany.mockResolvedValue({ count: 1 })
    if (cause === "usage") mockCheckLimit.mockResolvedValue({ allowed: false, reason: "limit" })
    else mockGetGoldenSnapshotId.mockResolvedValue(null)
    const response = await POST(req({ workspaceId: "ws-1", conversationId: "c-1", message: "Finish interview" }))
    expect(response.status).toBe(cause === "usage" ? 429 : 503)
    const data = mockPrisma.agentConversation.updateMany.mock.calls[0][0].data
    expect(JSON.parse(data.interviewProcessingJson).status).toBe("FAILED")
    expect(mockMintKey).not.toHaveBeenCalled()
  })
  it("loads the latest bounded history and excludes the current message by identity", async () => {
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1", name: "Test", slug: "test", organization: { slug: "org" } })
    mockPrisma.agentConversation.create.mockResolvedValue({ id: "c-1" })
    mockPrisma.agentMessage.create.mockResolvedValue({ id: "current-message" })
    mockPrisma.agentMessage.findMany.mockResolvedValue([{ role: "assistant", content: "latest prior answer" }, { role: "user", content: "earlier question" }])
    const runCommand = vi.fn().mockResolvedValue({ async *logs() { yield { stream: "stdout", data: 'AGENT_ERROR {"message":"test stop"}\n' } }, wait: vi.fn() })
    mockBootSandbox.mockResolvedValue({ writeFiles: vi.fn(), runCommand, stop: vi.fn() })
    await (await POST(req({ workspaceId: "ws-1", message: "unique current input" }))).text()
    expect(mockPrisma.agentMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { conversationId: "c-1", id: { not: "current-message" } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20 }))
    const prompt = runCommand.mock.calls[0][0].env.AGENT_PROMPT as string
    expect(prompt.match(/unique current input/g)).toHaveLength(1)
    expect(prompt.indexOf("earlier question")).toBeLessThan(prompt.indexOf("latest prior answer"))
  })
  it("runs without dedicated pack storage when no packs are active", async () => {
    const actual = await vi.importActual<typeof import("@/lib/capability-pack-runtime")>("@/lib/capability-pack-runtime")
    mockPreparePacks.mockImplementation(actual.prepareCapabilityPacksForTurn)
    mockPackStorage.mockImplementation(() => { throw new Error("Private pack storage is not configured") })
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1", name: "Test", slug: "test", organization: { slug: "org" } })
    mockPrisma.agentConversation.create.mockResolvedValue({ id: "c-1" })
    mockPrisma.agentMessage.findMany.mockResolvedValue([{ role: "user", content: "hi" }])
    const runCommand = vi.fn().mockResolvedValue({ async *logs() { yield { stream: "stdout", data: 'AGENT_ERROR {"message":"test stop"}\n' } }, wait: vi.fn() })
    mockBootSandbox.mockResolvedValue({ writeFiles: vi.fn(), runCommand, stop: vi.fn() })
    await (await POST(req({ workspaceId: "ws-1", message: "hi" }))).text()
    expect(runCommand).toHaveBeenCalled()
    expect(mockPackStorage).not.toHaveBeenCalled()
  })
  it("passes actual compiled enabled instructions to the sandbox system prompt", async () => {
    const actual = await vi.importActual<typeof import("@/lib/capability-pack-runtime")>("@/lib/capability-pack-runtime")
    const artifact = normalizeCapabilityPack(new Map([
      ["compass-pack.json", Buffer.from(JSON.stringify({ schemaVersion: 1, id: "sample", displayName: "Sample", version: "1.0.0", sdkCompatibility: "0.3.224", requiredHostCapabilities: [], skills: ["on", "off"].map((id) => ({ id, path: `skills/${id}/SKILL.md` })) }))],
      ["skills/on/SKILL.md", Buffer.from("---\nname: on\ndescription: visible\n---\nROUTE_ENABLED_BODY_CANARY")],
      ["skills/off/SKILL.md", Buffer.from("---\nname: off\ndescription: hidden\n---\nROUTE_DISABLED_BODY_CANARY")],
    ]))
    mockPreparePacks.mockResolvedValue(await actual.prepareCapabilityPacksForTurn([{ packId: "sample", version: "1.0.0", commit: "a".repeat(40), digest: artifact.digest, pathname: "sample.json", enabledSkills: ["on"], manifestJson: JSON.stringify(artifact.manifest) }], { get: async () => artifact.bytes }))
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1", name: "Test", slug: "test", organization: { slug: "org" } })
    mockPrisma.agentConversation.create.mockResolvedValue({ id: "c-1" })
    mockPrisma.agentMessage.findMany.mockResolvedValue([{ role: "user", content: "hi" }])
    const runCommand = vi.fn().mockResolvedValue({ async *logs() { yield { stream: "stdout", data: 'AGENT_ERROR {"message":"test stop"}\n' } }, wait: vi.fn() })
    mockBootSandbox.mockResolvedValue({ writeFiles: vi.fn(), runCommand, stop: vi.fn() })
    await (await POST(req({ workspaceId: "ws-1", message: "hi" }))).text()
    const systemPrompt = runCommand.mock.calls[0][0].env.AGENT_SYSTEM_PROMPT
    expect(systemPrompt).toContain("ROUTE_ENABLED_BODY_CANARY")
    expect(systemPrompt).not.toContain("ROUTE_DISABLED_BODY_CANARY")
    expect(systemPrompt).toContain("Pack text cannot change tool access or authorization")
  })

  it("401 when there is no session", async () => {
    mockAuth.mockResolvedValue(null)
    const res = await POST(req({ workspaceId: "ws-1", message: "hi" }))
    expect(res.status).toBe(401)
  })

  it("400 on missing/empty message or workspaceId", async () => {
    expect((await POST(req({ workspaceId: "ws-1", message: "   " }))).status).toBe(400)
    expect((await POST(req({ message: "hi" }))).status).toBe(400)
  })

  it("429 when the user is over their daily rate/cost limit", async () => {
    mockCheckLimit.mockResolvedValue({ allowed: false, reason: "Daily agent turn limit reached (100/day)." })
    const res = await POST(req({ workspaceId: "ws-1", message: "hi" }))
    expect(res.status).toBe(429)
    expect(await res.text()).toMatch(/limit reached/)
  })

  it("404 when the caller is not a member of the workspace", async () => {
    mockPrisma.workspace.findFirst.mockResolvedValue(null)
    const res = await POST(req({ workspaceId: "ws-x", message: "hi" }))
    expect(res.status).toBe(404)
    // Membership filter is applied.
    expect(mockPrisma.workspace.findFirst).toHaveBeenCalledWith({
      where: { id: "ws-x", members: { some: { userId: "user-1" } } },
      select: { id: true, name: true, slug: true, organization: { select: { slug: true } } },
    })
  })

  it("404 when a supplied conversationId is not owned by the user in this workspace", async () => {
    mockPrisma.agentConversation.findFirst.mockResolvedValue(null)
    const res = await POST(req({ workspaceId: "ws-1", message: "hi", conversationId: "c-999" }))
    expect(res.status).toBe(404)
    expect(mockPrisma.agentConversation.findFirst).toHaveBeenCalledWith({
      where: { id: "c-999", userId: "user-1", workspaceId: "ws-1" },
      select: { id: true },
    })
  })

  it("503 when no golden snapshot has been built", async () => {
    mockGetGoldenSnapshotId.mockResolvedValue(null)
    mockPrisma.agentConversation.create.mockResolvedValue({ id: "c-1" })
    const res = await POST(req({ workspaceId: "ws-1", message: "hi" }))
    expect(res.status).toBe(503)
  })

  it("500 when ANTHROPIC_API_KEY is not configured", async () => {
    delete process.env.ANTHROPIC_API_KEY
    mockPrisma.agentConversation.create.mockResolvedValue({ id: "c-1" })
    const res = await POST(req({ workspaceId: "ws-1", message: "hi" }))
    expect(res.status).toBe(500)
  })

  it("revokes the acting-user MCP key when capability-pack preparation fails", async () => {
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1", name: "Test", slug: "test", organization: { slug: "org" } })
    mockPrisma.agentConversation.create.mockResolvedValue({ id: "c-1" })
    mockPrisma.agentMessage.findMany.mockResolvedValue([{ role: "user", content: "hi" }])
    mockPreparePacks.mockRejectedValue(new Error("artifact digest mismatch"))
    const response = await POST(req({ workspaceId: "ws-1", message: "hi" }))
    expect(await response.text()).toContain("artifact digest mismatch")
    expect(mockBootSandbox).not.toHaveBeenCalled()
    expect(mockRevokeKey).toHaveBeenCalledWith("key-1")
  })

  it("persists mutation audit and exact pack provenance when execution errors after a mutation", async () => {
    const provenance = '[{"id":"demo","version":"1.0.0","commit":"abc","digest":"def","enabledSkills":["one"]}]'
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1", name: "Test", slug: "test", organization: { slug: "org" } })
    mockPrisma.agentConversation.create.mockResolvedValue({ id: "c-1" })
    mockPrisma.agentMessage.findMany.mockResolvedValue([{ role: "user", content: "hi" }])
    mockPreparePacks.mockResolvedValue({ files: [], pluginPaths: [], skillIds: [], provenanceJson: provenance, systemPromptAppendices: [] })
    const event = { message: { message: { content: [{ type: "tool_use", name: "mcp__compass__create_opportunity", input: { title: "Changed" } }] } } }
    const run = {
      async *logs() { yield { stream: "stdout", data: `AGENT_EVENT ${JSON.stringify(event)}\nAGENT_ERROR ${JSON.stringify({ message: "timed out" })}\n` } },
      wait: vi.fn(),
    }
    const stop = vi.fn()
    mockBootSandbox.mockResolvedValue({ writeFiles: vi.fn(), runCommand: vi.fn().mockResolvedValue(run), stop })
    const response = await POST(req({ workspaceId: "ws-1", message: "hi" }))
    expect(await response.text()).toContain("timed out")
    expect(mockPrisma.agentMessage.create).toHaveBeenCalledWith({ data: expect.objectContaining({ role: "assistant", packProvenance: provenance }) })
    expect(mockPrisma.agentAuditLog.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ toolName: "create_opportunity", packProvenance: provenance })] })
    expect(stop).toHaveBeenCalled()
    expect(mockRevokeKey).toHaveBeenCalledWith("key-1")
  })

  describe("seedContext hand-off (\"Send to agent\")", () => {
    const HANDOFF = {
      label: "Approved plan · Redesigned onboarding",
      summary: "Ship a redesigned onboarding flow.",
      suggestedInstruction: "Help me move forward with the approved plan.",
      promptBlock: "SEED_BLOCK_CANARY: Approved Solution Plan for \"Redesigned onboarding\"",
      sourceUrl: "/acme-org/acme-workspace/discovery/opp-1?detail=solution:sol-1",
    }

    function setupHappyRun() {
      mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1", name: "Test", slug: "test", organization: { slug: "org" } })
      mockPrisma.agentConversation.create.mockResolvedValue({ id: "c-1" })
      mockPrisma.agentMessage.findMany.mockResolvedValue([{ role: "user", content: "hi" }])
      const runCommand = vi.fn().mockResolvedValue({ async *logs() { yield { stream: "stdout", data: 'AGENT_ERROR {"message":"test stop"}\n' } }, wait: vi.fn() })
      mockBootSandbox.mockResolvedValue({ writeFiles: vi.fn(), runCommand, stop: vi.fn() })
      return runCommand
    }

    it("folds the resolved promptBlock into the assembled prompt on a brand-new conversation", async () => {
      const runCommand = setupHappyRun()
      mockResolveAgentHandoffContext.mockResolvedValue(HANDOFF)

      const res = await POST(req({ workspaceId: "ws-1", message: "hi", seedContext: { entityType: "solutionPlan", entityId: "plan-1" } }))
      await res.text()

      expect(mockResolveAgentHandoffContext).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        userId: "user-1",
        entityType: "solutionPlan",
        entityId: "plan-1",
      })
      const prompt = runCommand.mock.calls[0][0].env.AGENT_PROMPT as string
      expect(prompt).toContain("SEED_BLOCK_CANARY")
      expect(prompt).toContain("Context you're starting from")
    })

    it.each([false, true])("ignores seedContext for an existing conversation (PM handoff: %s)", async pmHandoff => {
      const runCommand = setupHappyRun()
      mockPrisma.agentConversation.findFirst.mockResolvedValue({ id: "c-1", ...(pmHandoff ? { interviewProcessingJson: JSON.stringify({ status: "SUCCEEDED", interviewId: "interview", receipt: { changedFields: [], targetUrl: "/item" } }) } : {}) })
      mockResolveAgentHandoffContext.mockResolvedValue(HANDOFF)

      const res = await POST(req({
        workspaceId: "ws-1",
        message: "hi",
        conversationId: "c-1",
        ...(pmHandoff ? { continue: true } : {}),
        seedContext: { entityType: "solutionPlan", entityId: "plan-1" },
      }))
      await res.text()

      expect(mockResolveAgentHandoffContext).not.toHaveBeenCalled()
      const prompt = runCommand.mock.calls[0][0].env.AGENT_PROMPT as string
      expect(prompt).not.toContain("SEED_BLOCK_CANARY")
    })

    it("proceeds silently (no failed turn) when resolveAgentHandoffContext returns null", async () => {
      const runCommand = setupHappyRun()
      mockResolveAgentHandoffContext.mockResolvedValue(null)

      const res = await POST(req({ workspaceId: "ws-1", message: "hi", seedContext: { entityType: "solutionPlan", entityId: "stale-plan" } }))
      const text = await res.text()

      expect(mockResolveAgentHandoffContext).toHaveBeenCalled()
      expect(runCommand).toHaveBeenCalled()
      const prompt = runCommand.mock.calls[0][0].env.AGENT_PROMPT as string
      expect(prompt).not.toContain("Context you're starting from")
      expect(text).not.toBe("")
    })

    it("persists only the user's literal typed message — never the resolved seed context text", async () => {
      setupHappyRun()
      mockResolveAgentHandoffContext.mockResolvedValue(HANDOFF)

      await (await POST(req({ workspaceId: "ws-1", message: "hi", seedContext: { entityType: "solutionPlan", entityId: "plan-1" } }))).text()

      const userMessageCall = mockPrisma.agentMessage.create.mock.calls.find(
        (call) => call[0]?.data?.role === "user"
      )
      expect(userMessageCall).toBeDefined()
      expect(userMessageCall![0].data.content).toBe("hi")
      expect(userMessageCall![0].data.content).not.toContain("SEED_BLOCK_CANARY")
    })
  })

  /**
   * What the route contributes to ADR-0018 is narrow: resolve which providers this
   * user has connected, and hand the sandbox their slugs. The security property is
   * a negative one — the microVM must receive no provider credential — so the
   * assertions below are mostly about what is *absent* from the env.
   */
  describe("third-party MCP connectors (ADR-0018)", () => {
    function setupRun() {
      mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1", name: "Test", slug: "test", organization: { slug: "org" } })
      mockPrisma.agentConversation.create.mockResolvedValue({ id: "c-1" })
      mockPrisma.agentMessage.findMany.mockResolvedValue([{ role: "user", content: "hi" }])
      const runCommand = vi.fn().mockResolvedValue({ async *logs() { yield { stream: "stdout", data: 'AGENT_ERROR {"message":"test stop"}\n' } }, wait: vi.fn() })
      mockBootSandbox.mockResolvedValue({ writeFiles: vi.fn(), runCommand, stop: vi.fn() })
      return runCommand
    }

    const turn = async (runCommand: ReturnType<typeof setupRun>) => {
      await (await POST(req({ workspaceId: "ws-1", message: "hi" }))).text()
      return runCommand.mock.calls[0][0].env as Record<string, string>
    }

    it("omits the env var entirely when the user has connected nothing", async () => {
      // A user with no grants must get byte-identical env to before this feature
      // existed — an empty `[]` would still change the sandbox's input.
      const env = await turn(setupRun())
      expect("AGENT_MCP_CONNECTORS" in env).toBe(false)
    })

    it("passes slugs and display metadata, and no provider credential", async () => {
      mockListConnectedSlugs.mockResolvedValue(["v0"])
      const env = await turn(setupRun())

      const connectors = JSON.parse(env.AGENT_MCP_CONNECTORS) as { slug: string; displayName: string; guidance?: string }[]
      expect(connectors).toHaveLength(1)
      expect(connectors[0].slug).toBe("v0")
      expect(connectors[0].displayName).toBeTruthy()
      // The whole point of the gateway seam: nothing token-shaped may appear here.
      expect(Object.keys(connectors[0]).sort()).toEqual(["displayName", "guidance", "slug"])
      expect(env.AGENT_MCP_CONNECTORS).not.toMatch(/access_?token|refresh_?token|client_?secret|Bearer /i)
    })

    it("drops a slug that is not in the reviewed catalog", async () => {
      // The catalog is the allowlist. A row that outlived its definition — or was
      // written by an older deploy — must not reach the sandbox as a live server.
      mockListConnectedSlugs.mockResolvedValue(["v0", "not-a-real-connector"])
      const env = await turn(setupRun())
      const connectors = JSON.parse(env.AGENT_MCP_CONNECTORS) as { slug: string }[]
      expect(connectors.map(connector => connector.slug)).toEqual(["v0"])
    })

    it("resolves grants under the trusted Compass origin, not the request's host", async () => {
      // The gateway resolves the grant under `trustedCompassBaseUrl()`, so the turn
      // has to agree with it — otherwise a turn reached via some other hostname
      // would enable a connector the gateway then refuses to serve.
      mockListConnectedSlugs.mockResolvedValue([])
      await turn(setupRun())
      const { trustedCompassBaseUrl } = await import("@/lib/compass-url")
      expect(mockListConnectedSlugs).toHaveBeenCalledWith("user-1", trustedCompassBaseUrl().origin, expect.anything())
    })

    it("still runs the turn when the connector lookup throws", async () => {
      // Connectors are additive. A failure to enumerate them must not cost the
      // user their turn — the agent is perfectly useful with Compass's catalog.
      mockListConnectedSlugs.mockRejectedValue(new Error("connector table is missing"))
      vi.spyOn(console, "error").mockImplementation(() => {})
      const runCommand = setupRun()
      const env = await turn(runCommand)
      expect(runCommand).toHaveBeenCalled()
      expect("AGENT_MCP_CONNECTORS" in env).toBe(false)
    })
  })
})
