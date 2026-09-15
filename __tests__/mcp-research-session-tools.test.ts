/**
 * Read-side boundary for the two research transcript tools (ADR-0012 step 3).
 *
 * The central control is that `ResearchSession` carries participant PII,
 * credential material and voice/request operational state that must never reach
 * a model. These tests drive the real service through the real MCP handlers with
 * a mocked database that deliberately returns the FULL fat row — every forbidden
 * column populated with a distinctive sentinel. A `select`-only defence would
 * pass such a mock trivially, so asserting on `JSON.stringify(result)` here is
 * what proves the explicit projection (not the query shape) is load-bearing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  study: vi.fn(),
  sessions: vi.fn(),
  session: vi.fn(),
  turns: vi.fn(),
}))
vi.mock("@/lib/db", () => ({
  default: () => ({
    researchStudy: { findFirst: m.study },
    researchSession: { findMany: m.sessions, findFirst: m.session },
    researchTurn: { findMany: m.turns },
  }),
}))

import { getResearchSessionTool, listResearchSessionsTool } from "@/lib/research-tool-handlers"
import { runWithMcpActor } from "@/lib/mcp-authz"

const workspaceId = "00000000-0000-4000-8000-000000000001"
const studyId = "00000000-0000-4000-8000-000000000002"
const sessionId = "00000000-0000-4000-8000-000000000003"
const input = { workspaceId, studyId, sessionId }
const member = { userId: "member" }

/** Every value here must be absent from both tools' serialized output. */
const FORBIDDEN = {
  participantName: "Dana-Participant-Realname",
  participantEmail: "dana@participant-pii.example",
  resumeTokenHash: "f".repeat(64),
  participantTokenId: "44444444-4444-4444-8444-444444444444",
  audioUrl: "s3://compass-private-audio/raw-recording.webm",
  voiceLeaseId: "55555555-5555-4555-8555-555555555555",
  voiceLeaseExpiresAt: new Date("2026-03-03T03:03:03.000Z"),
  activeRequestId: "66666666-6666-4666-8666-666666666666",
  activeRequestExpiresAt: new Date("2026-04-04T04:04:04.000Z"),
  nextSequence: 987654321,
}

/** A row exactly as `findMany()` with no projection would hand it back. */
function fatSession(overrides: Record<string, unknown> = {}) {
  return {
    id: sessionId,
    studyId,
    modality: "CHAT",
    status: "COMPLETED",
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    completedAt: new Date("2026-01-01T00:30:00.000Z"),
    lastActiveAt: new Date("2026-01-01T00:29:00.000Z"),
    endedReason: "PARTICIPANT_COMPLETED",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:30:00.000Z"),
    summary: null,
    _count: { turns: 2 },
    ...FORBIDDEN,
    ...overrides,
  }
}

const turn = (sequence: number) => ({
  id: `turn-${sequence}`,
  role: sequence % 2 === 0 ? "INTERVIEWER" : "PARTICIPANT",
  content: `Turn ${sequence} content`,
  sequence,
})

const call = <T>(handler: (args: T) => Promise<unknown>, args: T) =>
  runWithMcpActor(member, () => handler(args)) as Promise<{
    content: { text: string }[]
    structuredContent: { ok: boolean; message: string; data: Record<string, unknown> }
  }>

beforeEach(() => {
  vi.clearAllMocks()
  m.study.mockResolvedValue({ id: studyId, workspaceId, studyType: "CUSTOMER_INTERVIEW", status: "ACTIVE", goal: "Goal", guide: "[]", _count: { sessions: 1 } })
  m.sessions.mockResolvedValue([fatSession()])
  m.session.mockResolvedValue(fatSession())
  m.turns.mockResolvedValue([turn(1), turn(2)])
})

describe("research session read tools — participant privacy", () => {
  it.each([
    ["list_research_sessions", listResearchSessionsTool],
    ["get_research_session", getResearchSessionTool],
  ])("%s returns no participant identity, credential or operational field", async (_name, handler) => {
    const serialized = JSON.stringify(await call(handler as (a: typeof input) => Promise<unknown>, input))
    for (const [field, value] of Object.entries(FORBIDDEN)) {
      expect(serialized, `${field} leaked`).not.toContain(String(value instanceof Date ? value.toISOString() : value))
    }
  })

  it.each([
    ["list_research_sessions", listResearchSessionsTool],
    ["get_research_session", getResearchSessionTool],
  ])("%s projects an exact allowlist of session keys", async (_name, handler) => {
    const result = await call(handler as (a: typeof input) => Promise<unknown>, input)
    const session = (result.structuredContent.data.items as Record<string, unknown>[] | undefined)?.[0] ?? result.structuredContent.data
    expect(Object.keys(session).filter(key => key !== "turns" && key !== "nextOffset").sort()).toEqual([
      "completedAt", "createdAt", "endedReason", "hasSummary", "id", "lastActiveAt",
      "modality", "startedAt", "status", "studyId", "turnCount",
    ])
  })

  it("asks the database only for allowlisted session and turn columns", async () => {
    await call(getResearchSessionTool, input)
    expect(Object.keys(m.session.mock.calls[0][0].select).sort()).toEqual([
      "_count", "completedAt", "createdAt", "endedReason", "id", "lastActiveAt",
      "modality", "startedAt", "status", "studyId", "summary",
    ])
    expect(m.turns.mock.calls[0][0].select).toEqual({ id: true, role: true, content: true, sequence: true })
  })

  it("reduces the overloaded summary column to a boolean and never returns its contents", async () => {
    m.session.mockResolvedValue(fatSession({ summary: JSON.stringify({ version: 1, pending: { id: "lease-claim-secret", startedAt: new Date().toISOString() } }) }))
    const running = await call(getResearchSessionTool, input)
    expect(JSON.stringify(running)).not.toContain("lease-claim-secret")
    expect(running.structuredContent.data.hasSummary).toBe(false)

    m.session.mockResolvedValue(fatSession({ summary: "Legacy plaintext summary of the interview" }))
    const legacy = await call(getResearchSessionTool, input)
    expect(JSON.stringify(legacy)).not.toContain("Legacy plaintext summary")
    expect(legacy.structuredContent.data.hasSummary).toBe(true)
  })

  it("frames transcript text as untrusted data rather than instructions", async () => {
    const result = await call(getResearchSessionTool, input)
    expect(result.content[0].text).toMatch(/untrusted/i)
    expect(result.content[0].text).toMatch(/not instructions/i)
  })
})

describe("research session read tools — study authorization", () => {
  it.each([
    ["list_research_sessions", listResearchSessionsTool],
    ["get_research_session", getResearchSessionTool],
  ])("%s refuses a PM_INTERVIEW study and never reads its transcript", async (_name, handler) => {
    m.study.mockResolvedValue({ id: studyId, workspaceId, studyType: "PM_INTERVIEW", status: "ACTIVE", goal: "Goal", guide: "[]", _count: { sessions: 1 } })
    const result = await call(handler as (a: typeof input) => Promise<unknown>, input)
    expect(result.structuredContent).toMatchObject({ ok: false, message: "Study not found" })
    expect(m.sessions).not.toHaveBeenCalled()
    expect(m.session).not.toHaveBeenCalled()
    expect(m.turns).not.toHaveBeenCalled()
  })

  it.each([
    ["list_research_sessions", listResearchSessionsTool],
    ["get_research_session", getResearchSessionTool],
  ])("%s denies a study outside the caller's workspace membership", async (_name, handler) => {
    m.study.mockResolvedValue(null)
    const result = await call(handler as (a: typeof input) => Promise<unknown>, input)
    expect(result.structuredContent).toMatchObject({ ok: false, message: "Study not found" })
    expect(m.study.mock.calls[0][0].where).toMatchObject({ id: studyId, workspace: { id: workspaceId, members: { some: { userId: "member" } } } })
    expect(m.sessions).not.toHaveBeenCalled()
    expect(m.turns).not.toHaveBeenCalled()
  })

  it("scopes the session lookup to the resolved study, not the caller-supplied id alone", async () => {
    await call(getResearchSessionTool, input)
    expect(m.session.mock.calls[0][0].where).toEqual({ id: sessionId, studyId })
  })

  it("reports a session that does not belong to the study as not found", async () => {
    m.session.mockResolvedValue(null)
    const result = await call(getResearchSessionTool, input)
    expect(result.structuredContent).toMatchObject({ ok: false, message: "Session not found" })
    expect(m.turns).not.toHaveBeenCalled()
  })
})

describe("research session read tools — pagination and filtering", () => {
  it("returns 20 turns and a next offset when a further page exists", async () => {
    m.turns.mockResolvedValue(Array.from({ length: 21 }, (_, i) => turn(i + 1)))
    const result = await call(getResearchSessionTool, { ...input, offset: 40 })
    expect(m.turns.mock.calls[0][0]).toMatchObject({ orderBy: { sequence: "asc" }, skip: 40, take: 21 })
    expect(result.structuredContent.data.turns).toHaveLength(20)
    expect(result.structuredContent.data.nextOffset).toBe(60)
  })

  it("ends turn pagination with a null next offset on the last page", async () => {
    m.turns.mockResolvedValue(Array.from({ length: 20 }, (_, i) => turn(i + 1)))
    const result = await call(getResearchSessionTool, { ...input, offset: 40 })
    expect(result.structuredContent.data.turns).toHaveLength(20)
    expect(result.structuredContent.data.nextOffset).toBeNull()
  })

  it("orders turns by sequence ascending in the returned page", async () => {
    m.turns.mockResolvedValue([turn(1), turn(2)])
    const result = await call(getResearchSessionTool, input)
    expect((result.structuredContent.data.turns as { sequence: number }[]).map(t => t.sequence)).toEqual([1, 2])
  })

  it("bounds and pages the session list the same way", async () => {
    m.sessions.mockResolvedValue(Array.from({ length: 21 }, (_, i) => fatSession({ id: `session-${i}` })))
    const result = await call(listResearchSessionsTool, { workspaceId, studyId, offset: 20 })
    expect(m.sessions.mock.calls[0][0]).toMatchObject({ skip: 20, take: 21, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })
    expect(result.structuredContent.data.items).toHaveLength(20)
    expect(result.structuredContent.data.count).toBe(20)
    expect(result.structuredContent.data.nextOffset).toBe(40)
  })

  it("filters the session list by status and omits the filter when absent", async () => {
    await call(listResearchSessionsTool, { workspaceId, studyId, status: "COMPLETED" })
    expect(m.sessions.mock.calls[0][0].where).toEqual({ studyId, status: "COMPLETED" })
    await call(listResearchSessionsTool, { workspaceId, studyId })
    expect(m.sessions.mock.calls[1][0].where).toEqual({ studyId })
  })

  it("rejects a negative or non-integer offset before querying", async () => {
    for (const offset of [-1, 1.5]) {
      const result = await call(getResearchSessionTool, { ...input, offset })
      expect(result.structuredContent.ok).toBe(false)
      expect(result.structuredContent.message).toMatch(/offset/i)
    }
    expect(m.turns).not.toHaveBeenCalled()
  })

  it("reports the turn count alongside the paged transcript", async () => {
    const result = await call(getResearchSessionTool, input)
    expect(result.structuredContent.data.turnCount).toBe(2)
  })
})
