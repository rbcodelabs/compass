/**
 * The worker callback channel (lib/agent-run-callback.ts).
 *
 * This is the one path into Compass that a sandbox takes with no session behind
 * it, so the guards are the whole point: the bearer shape, authenticate-before-
 * buffering-a-body, the transport cap, and the fact that a replayed terminal
 * event still finalizes the run instead of leaving it RUNNING until the sweeper
 * notices.
 *
 * Runs against the real control plane with an injected fake prisma, because the
 * behavior under test is the interaction between the two — mocking
 * `appendAgentRunEvents` here would only assert that the route calls it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const mockStopSandbox = vi.fn()
vi.mock("@/lib/agent-sandbox", () => ({ stopSandboxByName: (name: string) => mockStopSandbox(name) }))
const mockRevokeKey = vi.fn()
vi.mock("@/lib/agent-mcp-key", () => ({ revokeAgentMcpKey: (id: string) => mockRevokeKey(id) }))
const mockFinishClaim = vi.fn()
vi.mock("@/lib/pm-agent-service", () => ({
  finishInterviewProcessing: (...args: unknown[]) => mockFinishClaim(...args),
  reportPmAgentFailure: vi.fn(),
}))

import { handleAgentRunCallback } from "@/lib/agent-run-callback"
import { agentRunSandboxName, hashAgentRunWorkerToken, MAX_AGENT_RUN_CALLBACK_EVENTS } from "@/lib/agent-runs"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const RUN_ID = "11111111-1111-4111-8111-111111111111"
const TOKEN = "t".repeat(43)
const URL_BASE = `https://c.test/api/internal/agent/runs/${RUN_ID}`

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    conversationId: "c-1",
    workspaceId: "ws-1",
    userId: "user-1",
    status: "RUNNING",
    kind: "CHAT",
    claimId: null,
    apiKeyId: "key-1",
    sandboxName: agentRunSandboxName(RUN_ID),
    packProvenance: "[]",
    workerTokenHash: hashAgentRunWorkerToken(TOKEN),
    deadlineAt: new Date(Date.now() + 600_000),
    lastSeq: 0,
    eventCount: 0,
    payloadBytes: 0,
    ...overrides,
  }
}

function fakePrisma(row = runRow()) {
  const prisma: Any = {
    agentRun: {
      findUnique: vi.fn().mockResolvedValue(row),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    agentRunEvent: { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn().mockResolvedValue({}) },
    agentMessage: { create: vi.fn().mockResolvedValue({}) },
    agentConversation: { update: vi.fn().mockResolvedValue({}) },
    agentAuditLog: { createMany: vi.fn().mockResolvedValue({}) },
  }
  prisma.$transaction = (fn: (tx: Any) => Promise<unknown>) => fn(prisma)
  return prisma
}

function post(body: unknown, { token = TOKEN, url = `${URL_BASE}/events`, contentType = "application/json" as string | null, headers = {} as Record<string, string> } = {}) {
  return new Request(url, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(contentType ? { "content-type": contentType } : {}),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

const CLEANUP = { stopSandbox: mockStopSandbox, revokeKey: mockRevokeKey, finishClaim: mockFinishClaim }
const agentEvent = (seq: number) => ({ seq, type: "agent", payload: { message: { message: { content: [{ type: "text", text: "hi" }] } } } })

beforeEach(() => vi.clearAllMocks())

describe("worker bearer guard", () => {
  it("401s a missing, wrong-scheme, or wrong-length token before reading the body", async () => {
    const prisma = fakePrisma()
    const bad = [
      { token: "" },
      { token: "short" },
      { token: "t".repeat(44) },
      { headers: { authorization: `Token ${TOKEN}` }, token: "" },
    ]
    for (const options of bad) {
      const res = await handleAgentRunCallback(post({ events: [agentEvent(1)] }, options), RUN_ID, "events", prisma, CLEANUP)
      expect(res.status).toBe(401)
    }
    expect(prisma.agentRun.findUnique).not.toHaveBeenCalled()
  })

  it("400s a malformed run id or any query string on the callback URL", async () => {
    const prisma = fakePrisma()
    expect((await handleAgentRunCallback(post({ events: [agentEvent(1)] }), "not-a-uuid", "events", prisma, CLEANUP)).status).toBe(400)
    // A query string on an internal callback is a sign of a rewritten URL, and the
    // allowlist regex in lib/route-access.ts matches on path alone.
    const withQuery = await handleAgentRunCallback(post({ events: [agentEvent(1)] }, { url: `${URL_BASE}/events?x=1` }), RUN_ID, "events", prisma, CLEANUP)
    expect(withQuery.status).toBe(400)
    expect(prisma.agentRun.findUnique).not.toHaveBeenCalled()
  })

  it("401s a valid-shaped token that is not this run's", async () => {
    const prisma = fakePrisma()
    const res = await handleAgentRunCallback(post({ events: [agentEvent(1)] }, { token: "x".repeat(43) }), RUN_ID, "events", prisma, CLEANUP)
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: "INVALID_WORKER_TOKEN" })
    expect(prisma.agentRunEvent.createMany).not.toHaveBeenCalled()
  })

  it("401s once the run is terminal, so a zombie worker cannot append to a finished transcript", async () => {
    const prisma = fakePrisma(runRow({ status: "CANCELED" }))
    const res = await handleAgentRunCallback(post({ events: [agentEvent(1)] }), RUN_ID, "events", prisma, CLEANUP)
    expect(res.status).toBe(401)
    expect(prisma.agentRunEvent.createMany).not.toHaveBeenCalled()
  })
})

describe("body handling", () => {
  it("415s a non-JSON content type and 400s unparseable JSON", async () => {
    const prisma = fakePrisma()
    expect((await handleAgentRunCallback(post("x", { contentType: "text/plain" }), RUN_ID, "events", prisma, CLEANUP)).status).toBe(415)
    expect((await handleAgentRunCallback(post("{not json", {}), RUN_ID, "events", prisma, CLEANUP)).status).toBe(400)
  })

  it("accepts a charset-qualified JSON content type", async () => {
    const prisma = fakePrisma()
    const res = await handleAgentRunCallback(post({ events: [agentEvent(1)] }, { contentType: "application/json; charset=utf-8" }), RUN_ID, "events", prisma, CLEANUP)
    expect(res.status).toBe(200)
  })

  it("413s on a declared content-length over the transport cap without buffering it", async () => {
    const prisma = fakePrisma()
    const res = await handleAgentRunCallback(
      post({ events: [agentEvent(1)] }, { headers: { "content-length": String(10 * 1024 * 1024) } }),
      RUN_ID,
      "events",
      prisma,
      CLEANUP,
    )
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ code: "CALLBACK_PAYLOAD_TOO_LARGE" })
  })

  it("400s a batch that is empty, oversized, unknown-typed, or carrying extra keys", async () => {
    const prisma = fakePrisma()
    const bodies = [
      {},
      { events: [] },
      { events: Array.from({ length: MAX_AGENT_RUN_CALLBACK_EVENTS + 1 }, (_, i) => agentEvent(i + 1)) },
      { events: [{ seq: 1, type: "sneaky", payload: {} }] },
      { events: [{ seq: 0, type: "agent", payload: {} }] },
      // `.strict()` on both schemas: a worker cannot smuggle a field past validation.
      { events: [{ ...agentEvent(1), runId: "other" }] },
      { events: [agentEvent(1)], extra: true },
    ]
    for (const body of bodies) {
      const res = await handleAgentRunCallback(post(body), RUN_ID, "events", prisma, CLEANUP)
      expect(res.status).toBe(400)
    }
    expect(prisma.agentRunEvent.createMany).not.toHaveBeenCalled()
  })
})

describe("event ingestion", () => {
  it("accepts a batch and echoes the cursor the worker should resume from", async () => {
    const prisma = fakePrisma()
    const res = await handleAgentRunCallback(post({ events: [agentEvent(1), agentEvent(2)] }), RUN_ID, "events", prisma, CLEANUP)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "RUNNING", lastSeq: 2, accepted: [1, 2], replayed: [] })
    expect(res.headers.get("cache-control")).toBe("no-store")
  })

  it("reports a replayed batch as replayed, not as an error", async () => {
    const prisma = fakePrisma(runRow({ lastSeq: 2, eventCount: 2 }))
    prisma.agentRunEvent.findMany.mockResolvedValue([{ seq: 1 }, { seq: 2 }])
    const res = await handleAgentRunCallback(post({ events: [agentEvent(1), agentEvent(2)] }), RUN_ID, "events", prisma, CLEANUP)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "RUNNING", lastSeq: 2, accepted: [], replayed: [1, 2] })
  })
})

describe("terminal events", () => {
  it("finalizes a result: writes the assistant message, revokes the key, stops the sandbox", async () => {
    const prisma = fakePrisma()
    const res = await handleAgentRunCallback(
      post({
        events: [
          agentEvent(1),
          { seq: 2, type: "result", payload: { text: "Here is the answer.", usage: { durationMs: 1_000, numTurns: 2, totalCostUsd: 0.02, usage: { input_tokens: 5, output_tokens: 6 } } } },
        ],
      }),
      RUN_ID,
      "events",
      prisma,
      CLEANUP,
    )

    expect(await res.json()).toMatchObject({ status: "SUCCEEDED", finalized: true, accepted: [1, 2] })
    expect(prisma.agentMessage.create.mock.calls[0][0].data).toMatchObject({ role: "assistant", content: "Here is the answer.", outputTokens: 6 })
    expect(mockRevokeKey).toHaveBeenCalledWith("key-1")
    expect(mockStopSandbox).toHaveBeenCalledWith(agentRunSandboxName(RUN_ID))
  })

  it("finalizes an error event as FAILED with the worker's message", async () => {
    const prisma = fakePrisma()
    const res = await handleAgentRunCallback(
      post({ events: [{ seq: 1, type: "error", payload: { message: "Model provider throttled the request." } }] }),
      RUN_ID,
      "events",
      prisma,
      CLEANUP,
    )
    expect(await res.json()).toMatchObject({ status: "FAILED", finalized: true })
    expect(prisma.agentRun.updateMany.mock.calls.at(-1)![0].data).toMatchObject({ status: "FAILED", errorCode: "WORKER_REPORTED", error: "Model provider throttled the request." })
    expect(prisma.agentMessage.create.mock.calls[0][0].data.content).toContain("Model provider throttled the request.")
  })

  it("finalizes on a *replayed* terminal event too, so a lost response does not strand the run", async () => {
    const prisma = fakePrisma(runRow({ lastSeq: 1, eventCount: 1 }))
    prisma.agentRunEvent.findMany.mockResolvedValue([{ seq: 1 }])
    const res = await handleAgentRunCallback(
      post({ events: [{ seq: 1, type: "result", payload: { text: "already stored" } }] }),
      RUN_ID,
      "events",
      prisma,
      CLEANUP,
    )
    expect(await res.json()).toMatchObject({ status: "SUCCEEDED", finalized: true, accepted: [], replayed: [1] })
  })

  it("is finalized by its last word when a batch somehow carries two terminal events", async () => {
    const prisma = fakePrisma()
    const res = await handleAgentRunCallback(
      post({
        events: [
          { seq: 1, type: "error", payload: { message: "first" } },
          { seq: 2, type: "result", payload: { text: "recovered" } },
        ],
      }),
      RUN_ID,
      "events",
      prisma,
      CLEANUP,
    )
    expect(await res.json()).toMatchObject({ status: "SUCCEEDED" })
  })

  it("400s a result whose text is absent or absurd rather than storing a broken turn", async () => {
    const prisma = fakePrisma()
    for (const payload of [{}, { text: 42 }, { text: "x".repeat(200_001) }]) {
      const res = await handleAgentRunCallback(post({ events: [{ seq: 1, type: "result", payload }] }), RUN_ID, "events", prisma, CLEANUP)
      expect(res.status).toBe(400)
    }
  })

  it("forwards unfamiliar usage fields instead of rejecting a run's only result", async () => {
    const prisma = fakePrisma()
    const res = await handleAgentRunCallback(
      post({ events: [{ seq: 1, type: "result", payload: { text: "ok", usage: { durationMs: 1, brandNewSdkField: "x", usage: { input_tokens: 1, cache_read_input_tokens: 9 } } } }] }),
      RUN_ID,
      "events",
      prisma,
      CLEANUP,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: "SUCCEEDED" })
  })
})

describe("heartbeat", () => {
  it("records a beat and echoes the status so a canceled worker can stop itself", async () => {
    const prisma = fakePrisma()
    const res = await handleAgentRunCallback(
      new Request(`${URL_BASE}/heartbeat`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } }),
      RUN_ID,
      "heartbeat",
      prisma,
      CLEANUP,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: "RUNNING", lastSeq: 0 })
    // No body required, and none read: there is nothing a heartbeat could say.
    expect(prisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastHeartbeatAt: expect.any(Date) }) }))
  })

  it("401s a heartbeat for a run that is already terminal", async () => {
    const prisma = fakePrisma(runRow({ status: "SUCCEEDED" }))
    const res = await handleAgentRunCallback(
      new Request(`${URL_BASE}/heartbeat`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } }),
      RUN_ID,
      "heartbeat",
      prisma,
      CLEANUP,
    )
    expect(res.status).toBe(401)
  })

  it("409s when the run row moved underneath the beat", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.updateMany.mockResolvedValue({ count: 0 })
    const res = await handleAgentRunCallback(
      new Request(`${URL_BASE}/heartbeat`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } }),
      RUN_ID,
      "heartbeat",
      prisma,
      CLEANUP,
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "HEARTBEAT_RACE" })
  })
})

describe("unexpected failures", () => {
  it("hides an internal error behind a 500 with no detail", async () => {
    const prisma = fakePrisma()
    prisma.agentRun.findUnique.mockRejectedValue(new Error("DSQL: connection reset by peer"))
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await handleAgentRunCallback(post({ events: [agentEvent(1)] }), RUN_ID, "events", prisma, CLEANUP)
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("DSQL")
    error.mockRestore()
  })
})
