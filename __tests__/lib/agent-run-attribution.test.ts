/**
 * Run attribution on the control plane (lib/agent-runs.ts) and the model/instructions an agent contributes to a turn.
 * The columns come from migration 100, so every path is exercised both with it applied and with it missing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/agent-sandbox", () => ({ stopSandboxByName: vi.fn() }))
vi.mock("@/lib/agent-mcp-key", () => ({ revokeAgentMcpKey: vi.fn() }))
vi.mock("@/lib/pm-agent-service", () => ({ finishInterviewProcessing: vi.fn(), reportPmAgentFailure: vi.fn() }))

import { AgentRunError, agentRunAttributionAvailable, attachAgentRunKey, createAgentRun, resetAgentRunAttributionAvailabilityCache } from "@/lib/agent-runs"
import { agentModelForHarness } from "@/lib/agent-harness"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const NOW = new Date("2026-10-20T12:00:00.000Z")
const AGENT = "11111111-1111-4111-8111-111111111111"

function fakePrisma(options: { attribution: boolean | Error }) {
  const prisma: Any = {
    agentRun: {
      // The attribution probe selects the new columns; with migration 100 missing Prisma raises P2022.
      findMany: vi.fn(async () => {
        if (options.attribution === true) return []
        throw options.attribution === false ? Object.assign(new Error("column agent_id does not exist"), { code: "P2022" }) : options.attribution
      }),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }: Any) => ({ id: data.id, ...data })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  }
  prisma.$transaction = (fn: (tx: Any) => Promise<unknown>) => fn(prisma)
  return prisma
}

beforeEach(() => resetAgentRunAttributionAvailabilityCache())

describe("createAgentRun attribution", () => {
  it("records the agent and the invoking user when migration 100 is applied", async () => {
    const prisma = fakePrisma({ attribution: true })
    await createAgentRun({ prisma, conversationId: "c", workspaceId: "w", userId: "u", agentId: AGENT, now: NOW })
    expect(prisma.agentRun.create.mock.calls[0][0].data).toMatchObject({ agentId: AGENT, invokedByUserId: "u", userId: "u" })
  })

  it("attributes a built-in run to nobody (NULL agent) but still records the invoker", async () => {
    const prisma = fakePrisma({ attribution: true })
    await createAgentRun({ prisma, conversationId: "c", workspaceId: "w", userId: "u", now: NOW })
    expect(prisma.agentRun.create.mock.calls[0][0].data).toMatchObject({ agentId: null, invokedByUserId: "u" })
  })

  it("never asks the database to RETURN the new columns, so it works before migration 100", async () => {
    const prisma = fakePrisma({ attribution: true })
    await createAgentRun({ prisma, conversationId: "c", workspaceId: "w", userId: "u", now: NOW })
    const select = prisma.agentRun.create.mock.calls[0][0].select
    expect(select).toBeDefined()
    expect(select).not.toHaveProperty("agentId")
    expect(select).not.toHaveProperty("invokedByUserId")
    expect(select).toMatchObject({ id: true, deadlineAt: true })
  })

  it("before migration 100: a built-in run is written without the new columns", async () => {
    const prisma = fakePrisma({ attribution: false })
    await createAgentRun({ prisma, conversationId: "c", workspaceId: "w", userId: "u", now: NOW })
    const data = prisma.agentRun.create.mock.calls[0][0].data
    expect(data).not.toHaveProperty("agentId")
    expect(data).not.toHaveProperty("invokedByUserId")
  })

  it("before migration 100: a run that NAMES an agent is refused, not started unattributed", async () => {
    const prisma = fakePrisma({ attribution: false })
    await expect(createAgentRun({ prisma, conversationId: "c", workspaceId: "w", userId: "u", agentId: AGENT, now: NOW }))
      .rejects.toMatchObject({ status: 503, code: "AGENT_ATTRIBUTION_UNAVAILABLE" })
    expect(prisma.agentRun.create).not.toHaveBeenCalled()
  })

  it("rethrows any other probe failure instead of treating it as 'not applied'", async () => {
    const outage = Object.assign(new Error("connection reset"), { code: "P1001" })
    await expect(createAgentRun({ prisma: fakePrisma({ attribution: outage }), conversationId: "c", workspaceId: "w", userId: "u", now: NOW })).rejects.toBe(outage)
    await expect(createAgentRun({ prisma: fakePrisma({ attribution: outage }), conversationId: "c", workspaceId: "w", userId: "u", now: NOW })).rejects.not.toBeInstanceOf(AgentRunError)
  })

  it("probes once a positive result is known, and re-probes a negative one after the TTL", async () => {
    const applied = fakePrisma({ attribution: true })
    await agentRunAttributionAvailable(applied)
    await agentRunAttributionAvailable(applied)
    expect(applied.agentRun.findMany).toHaveBeenCalledTimes(1)

    resetAgentRunAttributionAvailabilityCache()
    const missing = fakePrisma({ attribution: false })
    expect(await agentRunAttributionAvailable(missing)).toBe(false)
    expect(await agentRunAttributionAvailable(missing)).toBe(false)
    expect(missing.agentRun.findMany).toHaveBeenCalledTimes(1)
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 31_000)
    expect(await agentRunAttributionAvailable(fakePrisma({ attribution: true }))).toBe(true)
    vi.useRealTimers()
  })
})

describe("attachAgentRunKey", () => {
  it("is fenced on a non-terminal run, so a canceled or swept run cannot be handed a working key", async () => {
    const prisma = fakePrisma({ attribution: true })
    expect(await attachAgentRunKey({ prisma, runId: "r", apiKeyId: "k", now: NOW })).toBe(true)
    expect(prisma.agentRun.updateMany).toHaveBeenCalledWith({ where: { id: "r", status: { in: ["QUEUED", "RUNNING"] } }, data: { apiKeyId: "k", updatedAt: NOW } })
    prisma.agentRun.updateMany.mockResolvedValueOnce({ count: 0 })
    expect(await attachAgentRunKey({ prisma, runId: "r", apiKeyId: "k" })).toBe(false)
  })
})

describe("agentModelForHarness", () => {
  it("passes a Claude model id on the Claude harness and a gateway reference on opencode", () => {
    expect(agentModelForHarness("claude-opus-4-5", "claude")).toBe("claude-opus-4-5")
    expect(agentModelForHarness("anthropic/claude-sonnet-5.5", "opencode")).toBe("anthropic/claude-sonnet-5.5")
  })
  it.each([
    ["empty", ""],
    ["null", null],
    ["a non-Claude id on the Claude harness", "gpt-5"],
    ["shell metacharacters", "claude-x; rm -rf /"],
    ["whitespace inside", "claude x"],
    ["too long", "claude-" + "a".repeat(100)],
  ])("ignores %s on the Claude harness", (_label, value) => {
    expect(agentModelForHarness(value as string | null, "claude")).toBeNull()
  })
  it("ignores a model with no provider on opencode and a gateway reference on Claude", () => {
    expect(agentModelForHarness("claude-sonnet-5", "opencode")).toBeNull()
    expect(agentModelForHarness("anthropic/claude-sonnet-5.5", "claude")).toBeNull()
  })
})
