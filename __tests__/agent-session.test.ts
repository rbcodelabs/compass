/**
 * Agent session resume (lib/agent-session.ts): planning what a turn resumes,
 * committing a finished transcript, and the cleanup hook.
 *
 * Runs against an in-memory fake of exactly the Prisma calls the module makes plus a
 * Map-backed storage, so the assertions are about behavior (what ends up stored,
 * which blobs are deleted, what the next turn is told) rather than call shapes.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"
import { gzipSync } from "node:zlib"
import {
  MAX_AGENT_SESSION_BYTES,
  MAX_GAP_MESSAGES,
  agentSessionBlobKey,
  agentSessionsAvailable,
  buildResumePrompt,
  commitAgentSession,
  deleteWorkspaceAgentSessions,
  findRunUserMessageId,
  harnessOfSessionBlobKey,
  looksLikeSessionBlob,
  planAgentSession,
  resetAgentSessionsAvailabilityCache,
} from "@/lib/agent-session"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const OTHER_SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const WS = "11111111-1111-4111-8111-111111111111"
const OTHER_WS = "22222222-2222-4222-8222-222222222222"
const CONV = "33333333-3333-4333-8333-333333333333"
const blob = (text = "transcript line") => new Uint8Array(gzipSync(Buffer.from(text.repeat(4))))

type Msg = { id: string; conversationId: string; role: string; content: string; createdAt: Date }

function world() {
  const messages: Msg[] = []
  const sessions = new Map<string, Any>()
  const objects = new Map<string, Uint8Array>()
  let clock = 1_000
  const say = (id: string, role: string, content = id, conversationId = CONV) => {
    messages.push({ id, conversationId, role, content, createdAt: new Date((clock += 1_000)) })
  }
  const prisma: Any = {
    agentSession: {
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async ({ where }: Any) => {
        const row = sessions.get(where.conversationId)
        return row ? { ...row } : null
      }),
      create: vi.fn(async ({ data }: Any) => {
        if (sessions.has(data.conversationId)) throw Object.assign(new Error("dup"), { code: "P2002" })
        sessions.set(data.conversationId, { ...data })
        return data
      }),
      updateMany: vi.fn(async ({ where, data }: Any) => {
        const row = sessions.get(where.conversationId)
        if (!row || row.revision !== where.revision) return { count: 0 }
        Object.assign(row, data)
        return { count: 1 }
      }),
      findMany: vi.fn(async ({ where }: Any) => [...sessions.values()].filter((row) => row.workspaceId === where.workspaceId)),
      deleteMany: vi.fn(async ({ where }: Any) => {
        for (const [key, row] of sessions) if (row.workspaceId === where.workspaceId) sessions.delete(key)
        return { count: 0 }
      }),
    },
    agentMessage: {
      findFirst: vi.fn(async ({ where, orderBy }: Any) => {
        let rows = messages.filter((m) => m.conversationId === where.conversationId)
        if (where.id) rows = rows.filter((m) => m.id === where.id)
        if (where.role) rows = rows.filter((m) => m.role === where.role)
        if (where.createdAt?.lte) rows = rows.filter((m) => m.createdAt <= where.createdAt.lte)
        if (orderBy) rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        return rows[0] ?? null
      }),
      findMany: vi.fn(async ({ where, take }: Any) =>
        messages
          .filter((m) => m.conversationId === where.conversationId && (!where.createdAt?.gte || m.createdAt >= where.createdAt.gte))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, take),
      ),
    },
  }
  const puts: string[] = []
  const dels: string[] = []
  const storage = () => ({
    put: vi.fn(async (key: string, bytes: Uint8Array) => {
      puts.push(key)
      objects.set(key, bytes)
      return { pathname: key }
    }),
    get: vi.fn(async (key: string) => objects.get(key) ?? null),
    del: vi.fn(async (key: string) => {
      dels.push(key)
      objects.delete(key)
    }),
  })
  return { prisma, messages, sessions, objects, say, storage, puts, dels }
}

beforeEach(() => resetAgentSessionsAvailabilityCache())

describe("looksLikeSessionBlob / blob keys", () => {
  it("accepts gzip and rejects everything else", () => {
    expect(looksLikeSessionBlob(blob())).toBe(true)
    expect(looksLikeSessionBlob(new Uint8Array([0x1f, 0x8b, 1, 2]))).toBe(false)
    expect(looksLikeSessionBlob(new Uint8Array(40))).toBe(false)
    expect(looksLikeSessionBlob(new Uint8Array(MAX_AGENT_SESSION_BYTES + 1).fill(1))).toBe(false)
  })

  it("mints a fresh key per call, scoped by workspace and conversation", () => {
    const a = agentSessionBlobKey(WS, CONV)
    const b = agentSessionBlobKey(WS, CONV)
    expect(a).toMatch(new RegExp(`^agent-sessions/${WS}/${CONV}/[0-9a-f-]{36}\\.jsonl\\.gz$`))
    expect(a).not.toBe(b)
  })
})

describe("agentSessionsAvailable", () => {
  it("is false (and re-probed after the TTL) when the table is missing", async () => {
    const prisma: Any = { agentSession: { findFirst: vi.fn().mockRejectedValue(Object.assign(new Error("x"), { code: "P2021" })) } }
    expect(await agentSessionsAvailable(prisma)).toBe(false)
    expect(await agentSessionsAvailable(prisma)).toBe(false)
    expect(prisma.agentSession.findFirst).toHaveBeenCalledTimes(1)
  })

  it("rethrows real faults instead of hiding them as 'unavailable'", async () => {
    const prisma: Any = { agentSession: { findFirst: vi.fn().mockRejectedValue(new Error("connection reset")) } }
    await expect(agentSessionsAvailable(prisma)).rejects.toThrow("connection reset")
  })
})

describe("commitAgentSession", () => {
  it("stores the first transcript and creates the pointer", async () => {
    const w = world()
    w.say("u1", "user")
    const result = await commitAgentSession({ prisma: w.prisma, conversationId: CONV, workspaceId: WS, sessionId: SESSION, throughMessageId: "u1", bytes: blob(), storage: w.storage })
    expect(result).toEqual({ committed: true, revision: 1 })
    const row = w.sessions.get(CONV)
    expect(row).toMatchObject({ workspaceId: WS, sessionId: SESSION, throughMessageId: "u1", revision: 1 })
    expect(w.objects.has(row.blobKey)).toBe(true)
  })

  it("moves the pointer, bumps the revision, and deletes the previous object", async () => {
    const w = world()
    w.say("u1", "user")
    w.say("a1", "assistant")
    w.say("u2", "user")
    await commitAgentSession({ prisma: w.prisma, conversationId: CONV, workspaceId: WS, sessionId: SESSION, throughMessageId: "u1", bytes: blob("one"), storage: w.storage })
    const firstKey = w.sessions.get(CONV).blobKey
    const result = await commitAgentSession({ prisma: w.prisma, conversationId: CONV, workspaceId: WS, sessionId: SESSION, throughMessageId: "u2", bytes: blob("two"), storage: w.storage })
    expect(result).toEqual({ committed: true, revision: 2 })
    expect(w.sessions.get(CONV).blobKey).not.toBe(firstKey)
    expect(w.objects.has(firstKey)).toBe(false)
    expect(w.objects.size).toBe(1)
  })

  it("refuses to roll the session back to an older turn (overlapping sync turns)", async () => {
    const w = world()
    w.say("u1", "user")
    w.say("u2", "user")
    await commitAgentSession({ prisma: w.prisma, conversationId: CONV, workspaceId: WS, sessionId: SESSION, throughMessageId: "u2", bytes: blob("new"), storage: w.storage })
    const keptKey = w.sessions.get(CONV).blobKey
    const result = await commitAgentSession({ prisma: w.prisma, conversationId: CONV, workspaceId: WS, sessionId: OTHER_SESSION, throughMessageId: "u1", bytes: blob("old"), storage: w.storage })
    expect(result).toEqual({ committed: false, reason: "STALE" })
    expect(w.sessions.get(CONV)).toMatchObject({ throughMessageId: "u2", sessionId: SESSION, blobKey: keptKey })
    // The loser's object is removed; only the winner's remains.
    expect([...w.objects.keys()]).toEqual([keptKey])
  })

  it("loses a compare-and-set race without clobbering the winner, then retries", async () => {
    const w = world()
    w.say("u1", "user")
    w.say("u2", "user")
    await commitAgentSession({ prisma: w.prisma, conversationId: CONV, workspaceId: WS, sessionId: SESSION, throughMessageId: "u1", bytes: blob("one"), storage: w.storage })
    const real = w.prisma.agentSession.updateMany.getMockImplementation()!
    let raced = false
    w.prisma.agentSession.updateMany.mockImplementation(async (args: Any) => {
      if (!raced) {
        raced = true
        w.sessions.get(CONV).revision += 1 // someone else committed in between
      }
      return real(args)
    })
    const result = await commitAgentSession({ prisma: w.prisma, conversationId: CONV, workspaceId: WS, sessionId: SESSION, throughMessageId: "u2", bytes: blob("two"), storage: w.storage })
    expect(result.committed).toBe(true)
    expect(result.revision).toBe(3)
    expect(w.objects.size).toBe(1)
  })

  it("rejects malformed input before touching storage", async () => {
    const w = world()
    w.say("u1", "user")
    const base = { prisma: w.prisma, conversationId: CONV, workspaceId: WS, throughMessageId: "u1", storage: w.storage }
    expect(await commitAgentSession({ ...base, sessionId: "not-a-uuid", bytes: blob() })).toEqual({ committed: false, reason: "INVALID" })
    expect(await commitAgentSession({ ...base, sessionId: SESSION, bytes: new Uint8Array(64) })).toEqual({ committed: false, reason: "INVALID" })
    expect(await commitAgentSession({ ...base, sessionId: SESSION, bytes: blob(), throughMessageId: "missing" })).toEqual({ committed: false, reason: "INVALID" })
    expect(w.puts).toHaveLength(0)
  })

  it("never lets another workspace overwrite a conversation's session", async () => {
    const w = world()
    w.say("u1", "user")
    await commitAgentSession({ prisma: w.prisma, conversationId: CONV, workspaceId: WS, sessionId: SESSION, throughMessageId: "u1", bytes: blob(), storage: w.storage })
    const result = await commitAgentSession({ prisma: w.prisma, conversationId: CONV, workspaceId: OTHER_WS, sessionId: OTHER_SESSION, throughMessageId: "u1", bytes: blob("evil"), storage: w.storage })
    expect(result).toEqual({ committed: false, reason: "INVALID" })
    expect(w.sessions.get(CONV)).toMatchObject({ workspaceId: WS, sessionId: SESSION })
    expect(w.objects.size).toBe(1)
  })

  it("removes the new object when the pointer write throws", async () => {
    const w = world()
    w.say("u1", "user")
    w.prisma.agentSession.create.mockRejectedValue(new Error("db down"))
    await expect(
      commitAgentSession({ prisma: w.prisma, conversationId: CONV, workspaceId: WS, sessionId: SESSION, throughMessageId: "u1", bytes: blob(), storage: w.storage }),
    ).rejects.toThrow("db down")
    expect(w.objects.size).toBe(0)
  })
})

describe("planAgentSession", () => {
  const plan = (w: ReturnType<typeof world>, currentMessageId: string, workspaceId = WS) =>
    planAgentSession({ prisma: w.prisma, conversationId: CONV, workspaceId, currentMessageId, storage: w.storage })

  async function withStoredSession() {
    const w = world()
    w.say("u1", "user", "first question")
    w.say("a1", "assistant", "first answer")
    await commitAgentSession({ prisma: w.prisma, conversationId: CONV, workspaceId: WS, sessionId: SESSION, throughMessageId: "u1", bytes: blob(), storage: w.storage })
    return w
  }

  it("starts a fresh session when none is stored", async () => {
    const w = world()
    w.say("u1", "user")
    const result = await plan(w, "u1")
    expect(result).toMatchObject({ enabled: true, resume: null })
  })

  it("is disabled, not failing, when the migration has not been applied", async () => {
    const w = world()
    w.prisma.agentSession.findFirst.mockRejectedValue(Object.assign(new Error("x"), { code: "P2021" }))
    expect(await plan(w, "u1")).toEqual({ enabled: false })
  })

  it("is disabled when storage is not configured", async () => {
    const w = world()
    const result = await planAgentSession({
      prisma: w.prisma,
      conversationId: CONV,
      workspaceId: WS,
      currentMessageId: "u1",
      storage: () => {
        throw new Error("Agent session storage is not configured")
      },
    })
    expect(result).toEqual({ enabled: false })
  })

  it("resumes with no gap when nothing happened outside the session (the usual follow-up)", async () => {
    const w = await withStoredSession()
    w.say("u2", "user", "follow up")
    const result = await plan(w, "u2")
    expect(result).toMatchObject({ enabled: true, sessionId: SESSION })
    expect(result.enabled && result.resume?.gap).toEqual([])
  })

  it("replays only what the session has not seen", async () => {
    const w = await withStoredSession()
    w.say("u2", "user", "a turn that failed")
    w.say("a2", "assistant", "Agent turn failed: boom")
    w.say("u3", "user", "current")
    const result = await plan(w, "u3")
    expect(result.enabled && result.resume?.gap).toEqual([
      { role: "user", content: "a turn that failed" },
      { role: "assistant", content: "Agent turn failed: boom" },
    ])
  })

  it("falls back to a fresh session when the gap is too large", async () => {
    const w = await withStoredSession()
    for (let i = 0; i < MAX_GAP_MESSAGES + 2; i++) w.say(`g${i}`, i % 2 ? "assistant" : "user")
    w.say("cur", "user")
    const result = await plan(w, "cur")
    expect(result).toMatchObject({ enabled: true, resume: null })
    expect(result.enabled && result.sessionId).not.toBe(SESSION)
  })

  it("falls back when the stored object is missing or corrupt", async () => {
    const w = await withStoredSession()
    w.say("u2", "user")
    const key = w.sessions.get(CONV).blobKey
    w.objects.set(key, new Uint8Array(64))
    expect(await plan(w, "u2")).toMatchObject({ enabled: true, resume: null })
    w.objects.delete(key)
    expect(await plan(w, "u2")).toMatchObject({ enabled: true, resume: null })
  })

  describe("harness tagging (transcripts are not portable between harnesses)", () => {
    it("keeps Claude blob keys unchanged and tags opencode keys", () => {
      expect(agentSessionBlobKey(WS, CONV)).toMatch(/\/[0-9a-f-]{36}\.jsonl\.gz$/)
      expect(harnessOfSessionBlobKey(agentSessionBlobKey(WS, CONV))).toBe("claude")
      expect(agentSessionBlobKey(WS, CONV, "opencode")).toMatch(/\.opencode\.jsonl\.gz$/)
      expect(harnessOfSessionBlobKey(agentSessionBlobKey(WS, CONV, "opencode"))).toBe("opencode")
    })

    async function storedFor(harness: "claude" | "opencode") {
      const w = world()
      w.say("u1", "user", "first question")
      w.say("a1", "assistant", "first answer")
      await commitAgentSession({ prisma: w.prisma, conversationId: CONV, workspaceId: WS, sessionId: SESSION, throughMessageId: "u1", bytes: blob(), storage: w.storage, harness })
      w.say("u2", "user", "follow up")
      return w
    }
    const planFor = (w: ReturnType<typeof world>, harness: "claude" | "opencode") =>
      planAgentSession({ prisma: w.prisma, conversationId: CONV, workspaceId: WS, currentMessageId: "u2", storage: w.storage, harness })

    it("resumes an opencode transcript only for the opencode harness", async () => {
      const w = await storedFor("opencode")
      expect(await planFor(w, "opencode")).toMatchObject({ enabled: true, sessionId: SESSION })
      const other = await planFor(w, "claude")
      expect(other).toMatchObject({ enabled: true, resume: null })
      expect(other.enabled && other.sessionId).not.toBe(SESSION)
    })

    it("does not feed a Claude transcript to opencode", async () => {
      const w = await storedFor("claude")
      expect(await planFor(w, "claude")).toMatchObject({ enabled: true, sessionId: SESSION })
      expect(await planFor(w, "opencode")).toMatchObject({ enabled: true, resume: null })
    })

    it("replaces the pointer when the other harness commits, so each switch costs one replay", async () => {
      const w = await storedFor("claude")
      const first = w.sessions.get(CONV).blobKey
      await commitAgentSession({ prisma: w.prisma, conversationId: CONV, workspaceId: WS, sessionId: OTHER_SESSION, throughMessageId: "u2", bytes: blob("x"), storage: w.storage, harness: "opencode" })
      expect(w.sessions.get(CONV).blobKey).toMatch(/\.opencode\.jsonl\.gz$/)
      expect(w.dels).toContain(first)
    })
  })

  it("does not resume a pointer belonging to a different workspace", async () => {
    const w = await withStoredSession()
    w.say("u2", "user")
    expect(await plan(w, "u2", OTHER_WS)).toMatchObject({ enabled: true, resume: null })
  })

  it("falls back when the anchor message no longer exists", async () => {
    const w = await withStoredSession()
    w.messages.splice(0, 1)
    w.say("u2", "user")
    expect(await plan(w, "u2")).toMatchObject({ enabled: true, resume: null })
  })
})

describe("buildResumePrompt / findRunUserMessageId", () => {
  it("carries just the new message when nothing was missed", () => {
    expect(buildResumePrompt([], "hello")).toBe("User: hello\n\nAssistant:")
  })

  it("prefixes the messages the session did not see", () => {
    const prompt = buildResumePrompt([{ role: "user", content: "q" }, { role: "assistant", content: "a" }], "next")
    expect(prompt).toContain("you did not see them")
    expect(prompt).toContain("User: q\nAssistant: a")
    expect(prompt.endsWith("User: next\n\nAssistant:")).toBe(true)
  })

  it("anchors a run to the latest user message at or before it was created", async () => {
    const w = world()
    w.say("u1", "user")
    w.say("a1", "assistant")
    w.say("u2", "user")
    const createdAt = new Date(w.messages[2].createdAt.getTime() + 10)
    w.say("u3", "user") // arrives after the run row
    expect(await findRunUserMessageId(w.prisma, CONV, createdAt)).toBe("u2")
    expect(await findRunUserMessageId(w.prisma, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", createdAt)).toBeNull()
  })
})

describe("deleteWorkspaceAgentSessions", () => {
  it("deletes stored objects before the pointer rows and tolerates a blob failure", async () => {
    const w = world()
    w.say("u1", "user")
    await commitAgentSession({ prisma: w.prisma, conversationId: CONV, workspaceId: WS, sessionId: SESSION, throughMessageId: "u1", bytes: blob(), storage: w.storage })
    const storage = () => ({ put: vi.fn(), get: vi.fn(), del: vi.fn().mockRejectedValue(new Error("blob 500")) })
    await deleteWorkspaceAgentSessions(w.prisma, WS, storage as Any)
    expect(w.sessions.size).toBe(0)
  })

  it("is a no-op when the table is missing", async () => {
    const prisma: Any = { agentSession: { findFirst: vi.fn().mockRejectedValue(Object.assign(new Error("x"), { code: "P2021" })), deleteMany: vi.fn() } }
    await deleteWorkspaceAgentSessions(prisma, WS)
    expect(prisma.agentSession.deleteMany).not.toHaveBeenCalled()
  })
})
