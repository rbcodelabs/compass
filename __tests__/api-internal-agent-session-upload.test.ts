/**
 * Worker transcript upload (lib/agent-session-callback.ts).
 *
 * Same trust boundary as the run callback: bearer-shaped token, authentication before
 * the body is read, a transport cap that does not trust content-length, and tenant
 * scope taken from the run row — never from anything the sandbox sends.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { gzipSync } from "node:zlib"

import { handleAgentSessionUpload } from "@/lib/agent-session-callback"
import { resetAgentSessionsAvailabilityCache, MAX_AGENT_SESSION_BYTES } from "@/lib/agent-session"
import { agentRunSandboxName, hashAgentRunWorkerToken } from "@/lib/agent-runs"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const RUN_ID = "11111111-1111-4111-8111-111111111111"
const WS = "22222222-2222-4222-8222-222222222222"
const CONV = "33333333-3333-4333-8333-333333333333"
const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const TOKEN = "t".repeat(43)
const URL_BASE = `https://c.test/api/internal/agent/runs/${RUN_ID}/session`
const GZ = new Uint8Array(gzipSync(Buffer.from("line\n".repeat(20))))

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    conversationId: CONV,
    workspaceId: WS,
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
    createdAt: new Date(5_000),
    ...overrides,
  }
}

function harness(row = runRow(), { anchor = { id: "msg-user" } as { id: string } | null } = {}) {
  const sessions = new Map<string, Any>()
  const objects = new Map<string, Uint8Array>()
  const prisma: Any = {
    agentRun: { findUnique: vi.fn().mockResolvedValue(row) },
    agentSession: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn(async ({ where }: Any) => {
        const found = sessions.get(where.conversationId)
        return found ? { ...found } : null
      }),
      create: vi.fn(async ({ data }: Any) => {
        sessions.set(data.conversationId, { ...data })
        return data
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    agentMessage: {
      // findRunUserMessageId (latest user message at/before the run) and the
      // commit-time existence check both go through findFirst.
      findFirst: vi.fn().mockResolvedValue(anchor),
    },
  }
  const storage = () => ({
    put: vi.fn(async (key: string, bytes: Uint8Array) => {
      objects.set(key, bytes)
      return { pathname: key }
    }),
    get: vi.fn(async (key: string) => objects.get(key) ?? null),
    del: vi.fn(async (key: string) => void objects.delete(key)),
  })
  return { prisma, sessions, objects, storage }
}

function upload(body: BodyInit | null = GZ as Any, { token = TOKEN, url = URL_BASE, contentType = "application/gzip" as string | null, session = SESSION as string | null, headers = {} as Record<string, string> } = {}) {
  return new Request(url, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(contentType ? { "content-type": contentType } : {}),
      ...(session ? { "x-agent-session-id": session } : {}),
      ...headers,
    },
    body,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetAgentSessionsAvailabilityCache()
})

describe("guards that run before any body is read", () => {
  it("401s a missing or wrong-shaped bearer without touching the database", async () => {
    const h = harness()
    for (const token of ["", "short", "t".repeat(44)]) {
      const res = await handleAgentSessionUpload(upload(GZ as Any, { token }), RUN_ID, h.prisma, h.storage)
      expect(res.status).toBe(401)
    }
    expect(h.prisma.agentRun.findUnique).not.toHaveBeenCalled()
  })

  it("400s a malformed run id or a query string", async () => {
    const h = harness()
    expect((await handleAgentSessionUpload(upload(), "nope", h.prisma, h.storage)).status).toBe(400)
    expect((await handleAgentSessionUpload(upload(GZ as Any, { url: `${URL_BASE}?x=1` }), RUN_ID, h.prisma, h.storage)).status).toBe(400)
    expect(h.prisma.agentRun.findUnique).not.toHaveBeenCalled()
  })

  it("401s a well-formed token that is not this run's", async () => {
    const h = harness()
    const res = await handleAgentSessionUpload(upload(GZ as Any, { token: "x".repeat(43) }), RUN_ID, h.prisma, h.storage)
    expect(res.status).toBe(401)
    expect(h.objects.size).toBe(0)
  })

  it("rejects a terminal run: its worker token is no longer bound", async () => {
    for (const status of ["SUCCEEDED", "FAILED", "INTERRUPTED", "CANCELED"]) {
      const h = harness(runRow({ status }))
      const res = await handleAgentSessionUpload(upload(), RUN_ID, h.prisma, h.storage)
      expect(res.status).toBe(401)
      expect(h.objects.size).toBe(0)
    }
  })
})

describe("what a run may upload", () => {
  it("409s runs that never use sessions (handoff/interview kinds)", async () => {
    const h = harness(runRow({ kind: "HANDOFF" }))
    const res = await handleAgentSessionUpload(upload(), RUN_ID, h.prisma, h.storage)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "SESSION_NOT_SUPPORTED" })
    expect(h.objects.size).toBe(0)
  })

  it("400s a missing or non-uuid session id", async () => {
    const h = harness()
    for (const session of [null, "not-a-uuid", "../../etc/passwd"]) {
      const res = await handleAgentSessionUpload(upload(GZ as Any, { session }), RUN_ID, h.prisma, h.storage)
      expect(res.status).toBe(400)
    }
    expect(h.objects.size).toBe(0)
  })

  it("503s when migration 079 has not been applied", async () => {
    const h = harness()
    h.prisma.agentSession.findFirst.mockRejectedValue(Object.assign(new Error("x"), { code: "P2021" }))
    const res = await handleAgentSessionUpload(upload(), RUN_ID, h.prisma, h.storage)
    expect(res.status).toBe(503)
  })

  it("415s anything that is not application/gzip", async () => {
    const h = harness()
    const res = await handleAgentSessionUpload(upload(GZ as Any, { contentType: "application/json" }), RUN_ID, h.prisma, h.storage)
    expect(res.status).toBe(415)
  })

  it("413s an oversized declared content-length", async () => {
    const h = harness()
    const res = await handleAgentSessionUpload(
      upload(GZ as Any, { headers: { "content-length": String(MAX_AGENT_SESSION_BYTES + 1) } }),
      RUN_ID,
      h.prisma,
      h.storage,
    )
    expect(res.status).toBe(413)
    expect(h.objects.size).toBe(0)
  })

  it("413s an oversized stream even when content-length lies or is absent", async () => {
    const h = harness()
    const chunk = new Uint8Array(1_000_000)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ >= 6) return controller.close()
        controller.enqueue(chunk)
      },
    })
    const request = new Request(URL_BASE, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/gzip", "x-agent-session-id": SESSION },
      body,
      // @ts-expect-error node fetch requires duplex for stream bodies
      duplex: "half",
    })
    const res = await handleAgentSessionUpload(request, RUN_ID, h.prisma, h.storage)
    expect(res.status).toBe(413)
    expect(h.objects.size).toBe(0)
  })

  it("409s when there is no user message to anchor the session to", async () => {
    const h = harness(runRow(), { anchor: null })
    const res = await handleAgentSessionUpload(upload(), RUN_ID, h.prisma, h.storage)
    expect(res.status).toBe(409)
    expect(h.objects.size).toBe(0)
  })
})

describe("harness tag", () => {
  it("stores an opencode upload under an opencode-tagged key", async () => {
    const h = harness()
    const res = await handleAgentSessionUpload(upload(GZ as Any, { headers: { "x-agent-session-harness": "opencode" } }), RUN_ID, h.prisma, h.storage)
    expect(res.status).toBe(200)
    expect([...h.objects.keys()][0]).toMatch(/\.opencode\.jsonl\.gz$/)
  })

  it("treats a missing or unknown harness header as Claude", async () => {
    for (const headers of [{} as Record<string, string>, { "x-agent-session-harness": "other" }]) {
      const h = harness()
      const res = await handleAgentSessionUpload(upload(GZ as Any, { headers }), RUN_ID, h.prisma, h.storage)
      expect(res.status).toBe(200)
      expect([...h.objects.keys()][0]).not.toMatch(/\.opencode\./)
    }
  })
})

describe("committing", () => {
  it("stores the transcript under keys derived from the run row, not the request", async () => {
    const h = harness()
    const res = await handleAgentSessionUpload(
      // Hostile extras the sandbox might send; none of them may influence scope.
      upload(GZ as Any, { headers: { "x-agent-workspace-id": "evil", "x-agent-conversation-id": "evil" } }),
      RUN_ID,
      h.prisma,
      h.storage,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ committed: true, revision: 1 })
    const [key] = [...h.objects.keys()]
    expect(key.startsWith(`agent-sessions/${WS}/${CONV}/`)).toBe(true)
    expect(h.sessions.get(CONV)).toMatchObject({ workspaceId: WS, sessionId: SESSION, throughMessageId: "msg-user" })
  })

  it("422s bytes that are not a gzip stream and stores nothing", async () => {
    const h = harness()
    const res = await handleAgentSessionUpload(upload(new Uint8Array(64) as Any), RUN_ID, h.prisma, h.storage)
    expect(res.status).toBe(422)
    expect(h.objects.size).toBe(0)
  })

  it("answers 200/STALE (not an error) when a newer turn already committed", async () => {
    const h = harness()
    h.sessions.set(CONV, { conversationId: CONV, workspaceId: WS, sessionId: SESSION, blobKey: "k", throughMessageId: "newer", revision: 4 })
    // The existing pointer's anchor is newer than this run's.
    h.prisma.agentMessage.findFirst
      .mockResolvedValueOnce({ id: "msg-user" }) // run anchor
      .mockResolvedValueOnce({ id: "msg-user", createdAt: new Date(1_000) }) // through message exists
      .mockResolvedValueOnce({ id: "newer", createdAt: new Date(9_000) }) // existing anchor
    const res = await handleAgentSessionUpload(upload(), RUN_ID, h.prisma, h.storage)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ committed: false })
    expect(h.sessions.get(CONV).revision).toBe(4)
  })
})
