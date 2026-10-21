import { beforeEach, describe, expect, it, vi } from "vitest"

/* eslint-disable @typescript-eslint/no-explicit-any */
const m = vi.hoisted(() => ({
  boot: vi.fn(),
  mint: vi.fn(),
  revoke: vi.fn(),
  attach: vi.fn(),
  started: vi.fn(),
  finalize: vi.fn(),
  packs: vi.fn(),
  writeFiles: vi.fn(),
  runCommand: vi.fn(),
  runUpdate: vi.fn(),
  packRows: vi.fn(),
}))

vi.mock("@/lib/agent-sandbox", () => ({ bootSandboxFromSnapshot: (...a: unknown[]) => m.boot(...a) }))
vi.mock("@/lib/agent-mcp-key", () => ({ mintAgentMcpKey: (...a: unknown[]) => m.mint(...a), revokeAgentMcpKey: (...a: unknown[]) => m.revoke(...a) }))
vi.mock("@/lib/capability-pack-runtime", () => ({ prepareCapabilityPacksForTurn: (...a: unknown[]) => m.packs(...a) }))
vi.mock("@/lib/artifact-storage", () => ({ getCapabilityPackArtifactStorage: () => ({ get: vi.fn() }) }))
vi.mock("@/lib/agent-runs", async (original) => ({
  ...(await original<object>()),
  attachAgentRunKey: (...a: unknown[]) => m.attach(...a),
  markAgentRunStarted: (...a: unknown[]) => m.started(...a),
  finalizeAgentRun: (...a: unknown[]) => m.finalize(...a),
}))
vi.mock("@/lib/agent-run-sandbox", async (original) => ({
  ...(await original<object>()),
  readEntryScript: () => "ENTRY",
  readEntryModules: () => [{ path: "run-reporter.ts", content: "R" }],
}))

import { launchQueuedAgentRun, type LaunchContext } from "@/lib/agent-run-launch"

const prisma = { agentRun: { update: (...a: unknown[]) => m.runUpdate(...a) }, workspaceCapabilityPack: { findMany: (...a: unknown[]) => m.packRows(...a) } }
const deadlineAt = new Date("2026-10-21T13:20:00.000Z")

function context(over: Partial<LaunchContext> = {}): LaunchContext {
  return {
    prisma: prisma as any,
    run: { id: "run-1", deadlineAt },
    workerToken: "worker-token",
    sandboxName: "compass-agent-run-run-1",
    userId: "member",
    workspace: { id: "ws-1" },
    agent: { id: "agent-1", name: "Triage", instructions: "Be brief.", model: "claude-sonnet-5" },
    prompt: "PROMPT",
    snapshotId: "snap-1",
    harness: "claude",
    anthropicApiKey: "anthropic-key",
    budgetMs: 20 * 60_000,
    mcpBaseUrl: "https://compass.test",
    bypassSecret: "bypass",
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, "error").mockImplementation(() => {})
  m.packRows.mockResolvedValue([])
  m.packs.mockResolvedValue({ files: [{ path: "pack.txt", content: "p" }], pluginPaths: ["p1"], skillIds: ["s1"], provenanceJson: '[{"packId":"x"}]', systemPromptAppendices: ["APPENDIX"] })
  m.mint.mockResolvedValue({ token: "cmp_token", apiKeyId: "key-1" })
  m.attach.mockResolvedValue(true)
  m.started.mockResolvedValue(true)
  m.finalize.mockResolvedValue({ finalized: true })
  m.runUpdate.mockResolvedValue({ id: "run-1" })
  m.writeFiles.mockResolvedValue(undefined)
  m.runCommand.mockResolvedValue(undefined)
  m.boot.mockResolvedValue({ writeFiles: m.writeFiles, runCommand: m.runCommand })
})

describe("launchQueuedAgentRun", () => {
  it("mints the agent's key, attaches it to the run BEFORE the sandbox exists, then marks the run started", async () => {
    expect(await launchQueuedAgentRun(context())).toEqual({ started: true })
    expect(m.mint).toHaveBeenCalledWith("member", "ws-1", undefined, new Date(deadlineAt.getTime() + 60_000), { agentId: "agent-1" })
    expect(m.attach).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", apiKeyId: "key-1" }))
    expect(m.attach.mock.invocationCallOrder[0]).toBeLessThan(m.boot.mock.invocationCallOrder[0])
    expect(m.runCommand.mock.invocationCallOrder[0]).toBeLessThan(m.started.mock.invocationCallOrder[0])
    expect(m.started).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", apiKeyId: "key-1", sandboxName: "compass-agent-run-run-1" }))
    expect(m.finalize).not.toHaveBeenCalled()
  })

  it("records pack provenance on the run before anything boots", async () => {
    await launchQueuedAgentRun(context())
    expect(m.runUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "run-1" }, data: expect.objectContaining({ packProvenance: '[{"packId":"x"}]' }) }))
    expect(m.runUpdate.mock.invocationCallOrder[0]).toBeLessThan(m.boot.mock.invocationCallOrder[0])
  })

  it("boots the golden snapshot with the run's name, tags and a timeout wider than its deadline", async () => {
    await launchQueuedAgentRun(context())
    expect(m.boot).toHaveBeenCalledWith("snap-1", { timeoutMs: 20 * 60_000 + 120_000, name: "compass-agent-run-run-1", tags: { runId: "run-1", workspaceId: "ws-1" } })
    const files = (m.writeFiles.mock.calls[0][0] as { path: string }[]).map((f) => f.path)
    expect(files).toEqual(["entry.ts", "run-reporter.ts", "pack.txt"])
  })

  it("gives the sandbox the agent, the run callback, no connectors and no doc tree", async () => {
    await launchQueuedAgentRun(context())
    const { env, detached, timeoutMs } = m.runCommand.mock.calls[0][0]
    expect(detached).toBe(true)
    expect(timeoutMs).toBe(20 * 60_000)
    expect(env.AGENT_PROMPT).toBe("PROMPT")
    expect(env.MCP_TOKEN).toBe("cmp_token")
    expect(env.MCP_BASE_URL).toBe("https://compass.test")
    expect(env.AGENT_RUN_ID).toBe("run-1")
    expect(env.AGENT_RUN_TOKEN).toBe("worker-token")
    expect(env.AGENT_SYSTEM_PROMPT).toContain('You are running as the agent "Triage"')
    expect(env.AGENT_SYSTEM_PROMPT).toContain("Be brief.")
    expect(env.AGENT_SYSTEM_PROMPT).toContain("APPENDIX")
    expect(env.AGENT_MODEL).toBe("claude-sonnet-5")
    expect(env.ANTHROPIC_API_KEY).toBe("anthropic-key")
    expect(env).not.toHaveProperty("AGENT_MCP_CONNECTORS")
    expect(env).not.toHaveProperty("DOCS_ROOT")
    expect(env).not.toHaveProperty("AGENT_SESSION_ID")
  })

  it("uses the gateway credential, never the Anthropic key, on the opencode harness", async () => {
    await launchQueuedAgentRun(context({ harness: "opencode", gatewayApiKey: "gw", anthropicApiKey: "anthropic-key", agent: { id: "agent-1", name: "Triage", instructions: null, model: "anthropic/claude-sonnet-5.5" } }))
    const { env } = m.runCommand.mock.calls[0][0]
    expect(env.AI_GATEWAY_API_KEY).toBe("gw")
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY")
    expect(env.AGENT_MODEL).toBe("anthropic/claude-sonnet-5.5")
  })

  it("fails the run, revokes the key and does not boot when the run ended before its key could be attached", async () => {
    m.attach.mockResolvedValue(false)
    expect(await launchQueuedAgentRun(context())).toEqual({ started: false })
    expect(m.revoke).toHaveBeenCalledWith("key-1")
    expect(m.finalize).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", status: "FAILED", errorCode: "RUN_START_FAILED" }))
    expect(m.boot).not.toHaveBeenCalled()
  })

  it("fails the run and revokes the key when the sandbox cannot boot, and never throws", async () => {
    m.boot.mockRejectedValue(new Error("no sandbox capacity"))
    await expect(launchQueuedAgentRun(context())).resolves.toEqual({ started: false })
    expect(m.revoke).toHaveBeenCalledWith("key-1")
    expect(m.finalize).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED", errorCode: "RUN_START_FAILED", error: "The agent run could not start." }))
    expect(m.started).not.toHaveBeenCalled()
  })

  it("fails the run without a key to revoke when the key itself cannot be minted (agent no longer runnable)", async () => {
    m.mint.mockRejectedValue(new Error("Agent is not available to run."))
    await expect(launchQueuedAgentRun(context())).resolves.toEqual({ started: false })
    expect(m.revoke).not.toHaveBeenCalled()
    expect(m.finalize).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED" }))
    expect(m.boot).not.toHaveBeenCalled()
  })

  it("survives finalize itself failing", async () => {
    m.boot.mockRejectedValue(new Error("boom"))
    m.finalize.mockRejectedValue(new Error("db down"))
    await expect(launchQueuedAgentRun(context())).resolves.toEqual({ started: false })
  })
})
