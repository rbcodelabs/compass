/**
 * The run-viewing surface and the sweeper.
 *
 * These routes are what make a detached run visible and stoppable, so their
 * guards are the access-control boundary for a transcript that now outlives the
 * request that produced it:
 *
 *  - `/api/agent/runs/[runId]` (GET/DELETE) and its `/stream` are session-authed
 *    and allowlisted in lib/route-access.ts, so an anonymous caller must get a
 *    401 rather than a login redirect.
 *  - `/api/agent/conversations/[conversationId]/run` is the reattach lookup, and
 *    has to degrade to "nothing in flight" before migration 069 rather than error.
 *  - `/api/cron/agent-run-sweeper` is a termination endpoint reachable without a
 *    session, so it fails closed when no secret is configured.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const mockAuth = vi.fn()
vi.mock("@/auth", () => ({ auth: () => mockAuth() }))

const mockPrisma = {
  agentConversation: { findFirst: vi.fn() },
}
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

const runLib = vi.hoisted(() => ({
  available: vi.fn(),
  viewer: vi.fn(),
  events: vi.fn(),
  cancel: vi.fn(),
  findActive: vi.fn(),
  sweep: vi.fn(),
}))
vi.mock("@/lib/agent-runs", async (original) => ({
  ...(await original<object>()),
  agentRunsAvailable: runLib.available,
  getAgentRunForViewer: runLib.viewer,
  listAgentRunEvents: runLib.events,
  cancelAgentRun: runLib.cancel,
  findActiveAgentRun: runLib.findActive,
  sweepAgentRuns: runLib.sweep,
}))

import { AgentRunError } from "@/lib/agent-runs"
import { GET as getRun, DELETE as deleteRun } from "@/app/api/agent/runs/[runId]/route"
import { GET as getConversationRun } from "@/app/api/agent/conversations/[conversationId]/run/route"
import { GET as cronGet, POST as cronPost } from "@/app/api/cron/agent-run-sweeper/route"

const RUN_ID = "11111111-1111-4111-8111-111111111111"
const SESSION = { user: { id: "user-1" } }

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    conversationId: "c-1",
    workspaceId: "ws-1",
    status: "RUNNING",
    kind: "CHAT",
    lastSeq: 5,
    eventCount: 5,
    deadlineAt: new Date("2026-09-25T12:00:00.000Z"),
    createdAt: new Date("2026-09-25T11:40:00.000Z"),
    ...overrides,
  }
}

function event(seq: number) {
  return { seq, type: "agent", payloadJson: JSON.stringify({ seq }), createdAt: new Date("2026-09-25T11:41:00.000Z") }
}

/** Generic so each route gets the exact param shape its handler declares. */
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) })

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.CRON_SECRET
  delete process.env.MIGRATION_SECRET
  mockAuth.mockResolvedValue(SESSION)
  runLib.available.mockResolvedValue(true)
  runLib.events.mockResolvedValue([])
})

describe("GET /api/agent/runs/[runId]", () => {
  it("401s without a session, before any database read", async () => {
    mockAuth.mockResolvedValue(null)
    const res = await getRun(new Request(`https://c.test/api/agent/runs/${RUN_ID}`), params({ runId: RUN_ID }))
    expect(res.status).toBe(401)
    expect(runLib.viewer).not.toHaveBeenCalled()
  })

  it("404s a malformed run id without querying for it", async () => {
    const res = await getRun(new Request("https://c.test/api/agent/runs/not-a-uuid"), params({ runId: "not-a-uuid" }))
    expect(res.status).toBe(404)
    expect(runLib.viewer).not.toHaveBeenCalled()
  })

  it("404s a run belonging to someone else — indistinguishable from one that does not exist", async () => {
    runLib.viewer.mockResolvedValue(null)
    const res = await getRun(new Request(`https://c.test/api/agent/runs/${RUN_ID}`), params({ runId: RUN_ID }))
    expect(res.status).toBe(404)
    expect(runLib.viewer).toHaveBeenCalledWith(expect.objectContaining({ runId: RUN_ID, userId: "user-1" }))
  })

  it("returns the snapshot plus events after the cursor, and never caches", async () => {
    runLib.viewer.mockResolvedValue(runRow())
    runLib.events.mockResolvedValue([event(4), event(5)])

    const res = await getRun(new Request(`https://c.test/api/agent/runs/${RUN_ID}?afterSeq=3`), params({ runId: RUN_ID }))
    const body = await res.json()

    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(runLib.events).toHaveBeenCalledWith(expect.objectContaining({ runId: RUN_ID, afterSeq: 3 }))
    expect(body.run).toMatchObject({ id: RUN_ID, status: "RUNNING", done: false })
    expect(body.events.map((e: { seq: number }) => e.seq)).toEqual([4, 5])
    expect(body.nextSeq).toBe(5)
    expect(body.hasMore).toBe(false)
  })

  it("advances nextSeq by the last event *returned*, so a truncated page is not skipped", async () => {
    // The page stopped at seq 2 while the run is already at 5. Using run.lastSeq
    // as the cursor here would silently drop events 3–5 from the transcript.
    runLib.viewer.mockResolvedValue(runRow({ lastSeq: 5 }))
    runLib.events.mockResolvedValue([event(1), event(2)])
    const body = await (await getRun(new Request(`https://c.test/api/agent/runs/${RUN_ID}`), params({ runId: RUN_ID }))).json()
    expect(body.nextSeq).toBe(2)
    expect(body.hasMore).toBe(true)
  })

  it("holds the cursor still when a poll returns nothing, rather than resetting to 0", async () => {
    runLib.viewer.mockResolvedValue(runRow({ lastSeq: 3 }))
    runLib.events.mockResolvedValue([])
    const body = await (await getRun(new Request(`https://c.test/api/agent/runs/${RUN_ID}?afterSeq=3`), params({ runId: RUN_ID }))).json()
    expect(body.nextSeq).toBe(3)
    expect(body.hasMore).toBe(false)
  })

  it("treats a junk or negative afterSeq as 0 instead of failing the poll", async () => {
    runLib.viewer.mockResolvedValue(runRow())
    for (const raw of ["abc", "-5", ""]) {
      await getRun(new Request(`https://c.test/api/agent/runs/${RUN_ID}?afterSeq=${raw}`), params({ runId: RUN_ID }))
      expect(runLib.events).toHaveBeenLastCalledWith(expect.objectContaining({ afterSeq: 0 }))
    }
  })

  it("skips the event read entirely for a status-only poll (events=0)", async () => {
    runLib.viewer.mockResolvedValue(runRow())
    const body = await (await getRun(new Request(`https://c.test/api/agent/runs/${RUN_ID}?events=0`), params({ runId: RUN_ID }))).json()
    expect(runLib.events).not.toHaveBeenCalled()
    expect(body.events).toEqual([])
    expect(body.hasMore).toBe(true)
  })
})

describe("DELETE /api/agent/runs/[runId]", () => {
  it("401s without a session and never cancels", async () => {
    mockAuth.mockResolvedValue(null)
    const res = await deleteRun(new Request("https://c.test", { method: "DELETE" }), params({ runId: RUN_ID }))
    expect(res.status).toBe(401)
    expect(runLib.cancel).not.toHaveBeenCalled()
  })

  it("cancels the caller's own run and reports that it won the race", async () => {
    runLib.cancel.mockResolvedValue({ finalized: true, status: "CANCELED" })
    const res = await deleteRun(new Request("https://c.test", { method: "DELETE" }), params({ runId: RUN_ID }))
    expect(await res.json()).toEqual({ status: "CANCELED", canceled: true })
    expect(runLib.cancel).toHaveBeenCalledWith(expect.objectContaining({ runId: RUN_ID, userId: "user-1" }))
  })

  it("does not rewrite history when the run finished first", async () => {
    runLib.cancel.mockResolvedValue({ finalized: false, status: "SUCCEEDED" })
    const res = await deleteRun(new Request("https://c.test", { method: "DELETE" }), params({ runId: RUN_ID }))
    expect(await res.json()).toEqual({ status: "SUCCEEDED", canceled: false })
  })

  it("passes an AgentRunError's own status through, and hides anything else behind a 500", async () => {
    runLib.cancel.mockRejectedValue(new AgentRunError("Agent run not found", 404, "RUN_NOT_FOUND"))
    const notFound = await deleteRun(new Request("https://c.test", { method: "DELETE" }), params({ runId: RUN_ID }))
    expect(notFound.status).toBe(404)
    expect(await notFound.json()).toEqual({ error: "Agent run not found", code: "RUN_NOT_FOUND" })

    runLib.cancel.mockRejectedValue(new Error("DSQL: connection reset by peer"))
    const failed = await deleteRun(new Request("https://c.test", { method: "DELETE" }), params({ runId: RUN_ID }))
    expect(failed.status).toBe(500)
    expect(JSON.stringify(await failed.json())).not.toContain("DSQL")
  })
})

describe("GET /api/agent/conversations/[conversationId]/run", () => {
  const url = "https://c.test/api/agent/conversations/c-1/run?workspaceId=ws-1"

  it("401s without a session", async () => {
    mockAuth.mockResolvedValue(null)
    const res = await getConversationRun(new Request(url), params({ conversationId: "c-1" }))
    expect(res.status).toBe(401)
  })

  it("400s without a workspaceId, since ownership is scoped to one", async () => {
    const res = await getConversationRun(new Request("https://c.test/api/agent/conversations/c-1/run"), params({ conversationId: "c-1" }))
    expect(res.status).toBe(400)
    expect(mockPrisma.agentConversation.findFirst).not.toHaveBeenCalled()
  })

  it("404s a conversation the caller does not own, checking membership in the same query", async () => {
    mockPrisma.agentConversation.findFirst.mockResolvedValue(null)
    const res = await getConversationRun(new Request(url), params({ conversationId: "c-1" }))
    expect(res.status).toBe(404)
    expect(mockPrisma.agentConversation.findFirst.mock.calls[0][0].where).toMatchObject({
      id: "c-1",
      workspaceId: "ws-1",
      userId: "user-1",
      workspace: { members: { some: { userId: "user-1" } } },
    })
  })

  it("degrades to 'nothing in flight' before migration 069 instead of erroring the reattach", async () => {
    mockPrisma.agentConversation.findFirst.mockResolvedValue({ id: "c-1" })
    runLib.available.mockResolvedValue(false)
    const res = await getConversationRun(new Request(url), params({ conversationId: "c-1" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ run: null, available: false })
    expect(runLib.findActive).not.toHaveBeenCalled()
  })

  it("returns null when the conversation has no active run", async () => {
    mockPrisma.agentConversation.findFirst.mockResolvedValue({ id: "c-1" })
    runLib.findActive.mockResolvedValue(null)
    expect(await (await getConversationRun(new Request(url), params({ conversationId: "c-1" }))).json())
      .toEqual({ run: null, available: true })
  })

  it("serializes the in-flight run so the client can start watching it", async () => {
    mockPrisma.agentConversation.findFirst.mockResolvedValue({ id: "c-1" })
    runLib.findActive.mockResolvedValue({ id: RUN_ID })
    runLib.viewer.mockResolvedValue(runRow({ status: "QUEUED" }))
    const body = await (await getConversationRun(new Request(url), params({ conversationId: "c-1" }))).json()
    expect(body.available).toBe(true)
    expect(body.run).toMatchObject({ id: RUN_ID, status: "QUEUED", done: false, lastSeq: 5 })
    // Re-authorized as a viewer even though the conversation already checked out:
    // membership can have been revoked mid-run.
    expect(runLib.viewer).toHaveBeenCalledWith(expect.objectContaining({ runId: RUN_ID, userId: "user-1" }))
  })
})

describe("GET/POST /api/cron/agent-run-sweeper", () => {
  const url = "https://c.test/api/cron/agent-run-sweeper"

  it("fails closed with 503 when neither secret is configured — never sweeps anonymously", async () => {
    const res = await cronGet(new Request(url))
    expect(res.status).toBe(503)
    expect(runLib.sweep).not.toHaveBeenCalled()
  })

  it("401s a missing, malformed, or wrong bearer token", async () => {
    process.env.CRON_SECRET = "cron-secret"
    const attempts: Record<string, string>[] = [{}, { authorization: "cron-secret" }, { authorization: "Bearer wrong" }, { authorization: "Bearer " }]
    for (const headers of attempts) {
      const res = await cronGet(new Request(url, { headers }))
      expect(res.status).toBe(401)
    }
    expect(runLib.sweep).not.toHaveBeenCalled()
  })

  it("accepts the CRON_SECRET bearer Vercel Cron sends", async () => {
    process.env.CRON_SECRET = "cron-secret"
    runLib.sweep.mockResolvedValue({ examined: 0, swept: [], failed: [], truncated: false })
    const res = await cronGet(new Request(url, { headers: { authorization: "Bearer cron-secret" } }))
    expect(res.status).toBe(200)
    expect(runLib.sweep).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }))
  })

  it("accepts MIGRATION_SECRET as the manual-operator fallback, by bearer or header", async () => {
    process.env.MIGRATION_SECRET = "migrate-secret"
    runLib.sweep.mockResolvedValue({ examined: 0, swept: [], failed: [], truncated: false })
    expect((await cronPost(new Request(url, { method: "POST", headers: { authorization: "Bearer migrate-secret" } }))).status).toBe(200)
    expect((await cronPost(new Request(url, { method: "POST", headers: { "x-migration-secret": "migrate-secret" } }))).status).toBe(200)
    // The CRON_SECRET path must not accept a migration secret in the wrong header.
    process.env.CRON_SECRET = "cron-secret"
    delete process.env.MIGRATION_SECRET
    expect((await cronPost(new Request(url, { method: "POST", headers: { "x-migration-secret": "cron-secret" } }))).status).toBe(401)
  })

  it("skips quietly before migration 069 rather than 500ing once a minute", async () => {
    process.env.CRON_SECRET = "cron-secret"
    runLib.available.mockResolvedValue(false)
    const res = await cronGet(new Request(url, { headers: { authorization: "Bearer cron-secret" } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ skipped: "AGENT_RUNS_UNAVAILABLE", examined: 0, swept: [], failed: [] })
    expect(runLib.sweep).not.toHaveBeenCalled()
  })

  it("clamps the limit and reports what it swept", async () => {
    process.env.CRON_SECRET = "cron-secret"
    runLib.sweep.mockResolvedValue({ examined: 1, swept: [{ runId: RUN_ID, reason: "DEADLINE_EXPIRED" }], failed: [], truncated: false })
    const headers = { authorization: "Bearer cron-secret" }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    for (const [query, expected] of [["limit=1000", 100], ["limit=0", 1], ["limit=abc", 25], ["limit=7.9", 7]] as const) {
      await cronGet(new Request(`${url}?${query}`, { headers }))
      expect(runLib.sweep).toHaveBeenLastCalledWith(expect.objectContaining({ limit: expected }))
    }
    const body = await (await cronGet(new Request(url, { headers }))).json()
    expect(body.swept).toEqual([{ runId: RUN_ID, reason: "DEADLINE_EXPIRED" }])
    // A forced termination is worth having in the logs; nothing reads a cron body.
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
