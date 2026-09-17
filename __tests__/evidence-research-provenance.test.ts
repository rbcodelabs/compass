/**
 * ADR-0012 step 6a — the READ side of the research→Evidence provenance chain.
 *
 * Step 5 made promotion write `Evidence.researchSynthesisId` and
 * `EvidenceResearchSource`, but nothing read it back, so ADR-0002 invariant 6
 * ("findings and promoted Evidence cite exact source turns") was satisfied in
 * the database and invisible everywhere else.
 *
 * Two boundaries are load-bearing here and are what these tests defend:
 *
 *  1. TRANSCRIPT TEXT IS NEVER INLINED. `list_evidence` is gated by
 *     `assertEntityAccess(nodeType, nodeId)` — an OST-node gate. The research
 *     read tools are gated by `findMemberStudy`, which additionally excludes
 *     PM_INTERVIEW studies. Returning turn `content` through the evidence gate
 *     would open a second, weaker path to participant speech. The projection
 *     therefore emits identifiers only.
 *  2. PARTICIPANT PII NEVER REACHES OUTPUT. Resolving a turn walks
 *     ResearchTurn → ResearchSession → ResearchStudy, and `ResearchSession` is
 *     the row that carries `participantName`, `participantEmail`,
 *     `resumeTokenHash` and `audioUrl`. Mirroring
 *     __tests__/mcp-research-session-tools.test.ts, the mock returns the FULL
 *     fat session row and the assertion is made against the serialized output,
 *     so a `select`-only defence cannot pass these tests by itself.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  evidence: vi.fn(),
  sources: vi.fn(),
  turns: vi.fn(),
  opportunity: vi.fn(),
  workspace: vi.fn(),
  workspaceMember: vi.fn(),
}))

vi.mock("@/lib/db", () => ({
  default: () => ({
    evidence: { findMany: m.evidence, findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    evidenceResearchSource: { findMany: m.sources },
    researchTurn: { findMany: m.turns },
    opportunity: { findUnique: m.opportunity },
    workspace: { findFirst: m.workspace },
    workspaceMember: { findFirst: m.workspaceMember },
  }),
}))

import { listEvidence } from "@/lib/evidence-tool-handlers"
import { loadEvidenceProvenance } from "@/lib/evidence-provenance"
import { applyToolGate } from "@/lib/mcp-tool-gates"

const WS = "00000000-0000-4000-8000-000000000001"
const OTHER_WS = "00000000-0000-4000-8000-000000000099"
const OPP = "11111111-1111-4111-8111-111111111111"
const SYNTHESIS = "22222222-2222-4222-8222-222222222222"
const STUDY = "33333333-3333-4333-8333-333333333333"
const SESSION_A = "44444444-4444-4444-8444-44444444444a"
const SESSION_B = "44444444-4444-4444-8444-44444444444b"
const PROMOTED = "55555555-5555-4555-8555-555555555555"
const PLAIN = "66666666-6666-4666-8666-666666666666"
const TURN_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"
const TURN_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2"
const TURN_3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3"

/**
 * Every value here must be absent from the serialized `list_evidence` output.
 * `content` is the transcript text itself — the first boundary above; the rest
 * are the ResearchSession columns the second boundary protects.
 */
const FORBIDDEN = {
  content: "Participant said the export flow is unusable on mobile",
  participantName: "Dana-Participant-Realname",
  participantEmail: "dana@participant-pii.example",
  resumeTokenHash: "f".repeat(64),
  audioUrl: "s3://compass-private-audio/raw-recording.webm",
  voiceLeaseId: "77777777-7777-4777-8777-777777777777",
  activeRequestId: "88888888-8888-4888-8888-888888888888",
}

/** A ResearchSession row exactly as `findMany()` with no projection returns it. */
function fatSession(studyId = STUDY, workspaceId = WS) {
  return {
    id: SESSION_A,
    studyId,
    modality: "CHAT",
    status: "COMPLETED",
    nextSequence: 987654321,
    participantName: FORBIDDEN.participantName,
    participantEmail: FORBIDDEN.participantEmail,
    resumeTokenHash: FORBIDDEN.resumeTokenHash,
    audioUrl: FORBIDDEN.audioUrl,
    voiceLeaseId: FORBIDDEN.voiceLeaseId,
    activeRequestId: FORBIDDEN.activeRequestId,
    study: { id: studyId, workspaceId, name: "Mobile export study" },
  }
}

/** A ResearchTurn row exactly as an unprojected read returns it. */
function fatTurn(id: string, sequence: number, sessionId = SESSION_A, session = fatSession()) {
  return {
    id,
    sessionId,
    sequence,
    role: "PARTICIPANT",
    content: FORBIDDEN.content,
    createdAt: new Date("2026-02-02T02:02:02.000Z"),
    session: { ...session, id: sessionId },
  }
}

const promotedRow = {
  id: PROMOTED,
  workspaceId: WS,
  sourceType: "interview",
  excerpt: "Mobile export is unusable — Participants abandoned the flow on phones.",
  confidence: "high",
  sourceUrl: null,
  opportunityId: OPP,
  solutionId: null,
  assumptionId: null,
  researchSynthesisId: SYNTHESIS,
  findingKey: "b".repeat(64),
  createdAt: new Date("2026-03-03T03:03:03.000Z"),
  updatedAt: new Date("2026-03-03T03:03:03.000Z"),
}

const plainRow = {
  id: PLAIN,
  workspaceId: WS,
  sourceType: "support_ticket",
  confidence: "medium",
  excerpt: "Three tickets this week about the same thing.",
  sourceUrl: "https://example.com/ticket/1",
  opportunityId: OPP,
  solutionId: null,
  assumptionId: null,
  researchSynthesisId: null,
  findingKey: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
}

type ListResult = {
  content: { text: string }[]
  structuredContent: { ok: boolean; message: string; data: { items: Record<string, unknown>[]; count: number } }
}

const list = () => listEvidence({ nodeId: OPP, nodeType: "opportunity" }) as Promise<ListResult>

beforeEach(() => {
  vi.clearAllMocks()
  m.evidence.mockResolvedValue([promotedRow, plainRow])
  m.sources.mockResolvedValue([
    { evidenceId: PROMOTED, researchTurnId: TURN_1 },
    { evidenceId: PROMOTED, researchTurnId: TURN_2 },
  ])
  m.turns.mockResolvedValue([fatTurn(TURN_1, 7), fatTurn(TURN_2, 3)])
})

describe("list_evidence — research provenance projection", () => {
  it("returns the synthesis id and the exact source turns for a promoted row", async () => {
    const result = await list()
    const promoted = result.structuredContent.data.items.find(item => item.id === PROMOTED)!

    expect(promoted.research).toEqual({
      researchSynthesisId: SYNTHESIS,
      sources: [
        { researchTurnId: TURN_2, studyId: STUDY, sessionId: SESSION_A, sequence: 3, role: "PARTICIPANT", resolved: true },
        { researchTurnId: TURN_1, studyId: STUDY, sessionId: SESSION_A, sequence: 7, role: "PARTICIPANT", resolved: true },
      ],
    })
  })

  it("names the synthesis and every cited turn in the text rendering", async () => {
    const text = (await list()).content[0].text
    expect(text).toContain(SYNTHESIS)
    expect(text).toContain(TURN_1)
    expect(text).toContain(TURN_2)
    expect(text).toContain(STUDY)
  })

  it("leaves a non-promoted row's projection byte-identical to the pre-052 shape", async () => {
    const result = await list()
    const plain = result.structuredContent.data.items.find(item => item.id === PLAIN)!

    expect(plain).toEqual({
      id: PLAIN,
      sourceType: "support_ticket",
      excerpt: "Three tickets this week about the same thing.",
      confidence: "medium",
      sourceUrl: "https://example.com/ticket/1",
      parent: { type: "opportunity", id: OPP },
    })
    expect(Object.keys(plain)).not.toContain("research")
  })

  it("issues no provenance queries at all when nothing on the node was promoted", async () => {
    m.evidence.mockResolvedValue([plainRow])
    await list()
    expect(m.sources).not.toHaveBeenCalled()
    expect(m.turns).not.toHaveBeenCalled()
  })

  it("still reports the pre-052 empty case unchanged", async () => {
    m.evidence.mockResolvedValue([])
    const result = await list()
    expect(result.content[0].text).toBe("No evidence found.")
  })
})

describe("list_evidence — source turn ordering is stable", () => {
  it("orders by session then transcript sequence, not by the join table's order", async () => {
    m.sources.mockResolvedValue([
      { evidenceId: PROMOTED, researchTurnId: TURN_3 },
      { evidenceId: PROMOTED, researchTurnId: TURN_1 },
      { evidenceId: PROMOTED, researchTurnId: TURN_2 },
    ])
    m.turns.mockResolvedValue([
      fatTurn(TURN_3, 2, SESSION_B, fatSession()),
      fatTurn(TURN_1, 7, SESSION_A),
      fatTurn(TURN_2, 3, SESSION_A),
    ])

    const first = await list()
    // Same inputs in a different database order must produce the same output.
    m.sources.mockResolvedValue([
      { evidenceId: PROMOTED, researchTurnId: TURN_2 },
      { evidenceId: PROMOTED, researchTurnId: TURN_3 },
      { evidenceId: PROMOTED, researchTurnId: TURN_1 },
    ])
    m.turns.mockResolvedValue([
      fatTurn(TURN_1, 7, SESSION_A),
      fatTurn(TURN_3, 2, SESSION_B, fatSession()),
      fatTurn(TURN_2, 3, SESSION_A),
    ])
    const second = await list()

    const ids = (r: ListResult) =>
      ((r.structuredContent.data.items.find(i => i.id === PROMOTED)!.research as { sources: { researchTurnId: string }[] })
        .sources.map(s => s.researchTurnId))

    expect(ids(first)).toEqual([TURN_2, TURN_1, TURN_3])
    expect(ids(second)).toEqual(ids(first))
  })

  it("keeps a cited turn that no longer resolves, marked unresolved and ordered last", async () => {
    m.turns.mockResolvedValue([fatTurn(TURN_1, 7)])
    const result = await list()
    const research = result.structuredContent.data.items.find(i => i.id === PROMOTED)!.research as {
      sources: { researchTurnId: string; resolved: boolean }[]
    }

    expect(research.sources).toEqual([
      { researchTurnId: TURN_1, studyId: STUDY, sessionId: SESSION_A, sequence: 7, role: "PARTICIPANT", resolved: true },
      { researchTurnId: TURN_2, studyId: null, sessionId: null, sequence: null, role: null, resolved: false },
    ])
  })
})

describe("list_evidence — participant privacy", () => {
  it("returns no transcript text, participant identity, credential or voice field", async () => {
    const serialized = JSON.stringify(await list())
    for (const [field, value] of Object.entries(FORBIDDEN)) {
      expect(serialized, `${field} leaked`).not.toContain(value)
    }
  })

  it("projects an exact allowlist of source keys", async () => {
    const result = await list()
    const sources = (result.structuredContent.data.items.find(i => i.id === PROMOTED)!.research as {
      sources: Record<string, unknown>[]
    }).sources
    expect(Object.keys(sources[0]).sort()).toEqual([
      "researchTurnId", "resolved", "role", "sequence", "sessionId", "studyId",
    ])
  })

  it("asks the database only for allowlisted turn and session columns", async () => {
    await list()
    expect(m.turns.mock.calls[0][0].select).toEqual({
      id: true,
      sessionId: true,
      sequence: true,
      role: true,
      session: { select: { studyId: true, study: { select: { workspaceId: true } } } },
    })
    expect(m.sources.mock.calls[0][0].select).toEqual({ evidenceId: true, researchTurnId: true })
  })
})

describe("evidence provenance — cross-workspace denial", () => {
  it("list_evidence's gate refuses a node outside the caller's workspaces", async () => {
    m.opportunity.mockResolvedValue({ workspaceId: OTHER_WS })
    m.workspaceMember.mockResolvedValue(null)
    await expect(
      applyToolGate("list_evidence", { userId: "user-1" }, { nodeId: OPP, nodeType: "opportunity" })
    ).rejects.toThrow(/not found or access denied/)
  })

  it("scopes the turn lookup to the evidence's own workspace", async () => {
    await loadEvidenceProvenance([{ id: PROMOTED, workspaceId: WS, researchSynthesisId: SYNTHESIS }])
    expect(m.turns.mock.calls[0][0].where).toEqual({
      id: { in: [TURN_1, TURN_2] },
      session: { study: { workspaceId: { in: [WS] } } },
    })
  })

  it("refuses to resolve a turn whose study belongs to another workspace", async () => {
    // Belt and braces: even if the scoped query above were widened, the
    // per-row check must still reject the foreign turn rather than describe it.
    m.turns.mockResolvedValue([
      fatTurn(TURN_1, 7),
      { ...fatTurn(TURN_2, 3), session: { ...fatSession(STUDY, OTHER_WS), id: SESSION_A } },
    ])
    const map = await loadEvidenceProvenance([{ id: PROMOTED, workspaceId: WS, researchSynthesisId: SYNTHESIS }])
    const sources = map.get(PROMOTED)!.sources

    expect(sources.find(s => s.researchTurnId === TURN_1)!.resolved).toBe(true)
    expect(sources.find(s => s.researchTurnId === TURN_2)).toEqual({
      researchTurnId: TURN_2, studyId: null, sessionId: null, sequence: null, role: null, resolved: false,
    })
  })
})
