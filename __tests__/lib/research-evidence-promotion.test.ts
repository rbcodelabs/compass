import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * ADR-0012 step 5: promoting a synthesis finding into a linked, source-attributed
 * Evidence record.
 *
 * The contract under test is narrow and load-bearing:
 *  - Evidence and its EvidenceResearchSource rows are written in ONE transaction.
 *  - Sources are resolved from the stored synthesis and re-grounded against the
 *    saved turns at promotion time, not taken on the caller's word.
 *  - A retry converges; a different payload under the same key is refused.
 *  - A bad citation writes nothing at all.
 */
const db = vi.hoisted(() => ({ root: null as never }))
vi.mock("@/lib/db", () => ({ default: () => db.root }))

import {
  ResearchPromotionError,
  promoteResearchFindingToEvidence,
  researchFindingKey,
} from "@/lib/research-evidence-promotion"

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111"
const OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222"
const SYNTHESIS_ID = "33333333-3333-4333-8333-333333333333"
const STUDY_ID = "44444444-4444-4444-8444-444444444444"
const OPPORTUNITY_ID = "55555555-5555-4555-8555-555555555555"

const QUOTE_A = "we abandon the flow at the pricing step"
const QUOTE_B = "nobody on my team knows which plan we are on"

const theme = () => ({
  title: "Pricing is where planning stalls",
  description: "Participants consistently drop out when the plan comparison appears.",
  surprising: false,
  quotes: [
    { sessionId: "session-1", turnId: "turn-1", text: QUOTE_A },
    { sessionId: "session-2", turnId: "turn-2", text: QUOTE_B },
  ],
})

const synthesisDocument = (themes = [theme()]) => JSON.stringify({
  version: 1,
  kind: "synthesis",
  generatedAt: "2026-09-15T00:00:00.000Z",
  sourceFingerprint: "a".repeat(64),
  sourceSessionIds: ["session-1", "session-2"],
  guideFingerprint: "b".repeat(64),
  model: "claude-sonnet-5",
  promptVersion: "research-analysis-v1",
  summary: "Planning stalls at pricing.",
  themes,
  patterns: [],
  jobs: [],
  recommendations: [],
})

const savedTurns = () => [
  { id: "turn-1", sessionId: "session-1", role: "PARTICIPANT", content: `Honestly ${QUOTE_A} every time.` },
  { id: "turn-2", sessionId: "session-2", role: "PARTICIPANT", content: `${QUOTE_B}.` },
]

type Row = Record<string, unknown>
type TargetNode = { id: string; title: string; workspaceId: string } | null
type FindTarget = () => Promise<TargetNode>
let stored: { evidence: Row[]; sources: Row[] }
let writesOutsideTransaction: string[]
let transactionCalls: number
let synthesisRow: Row | null
let turns: Row[]

function makeClient() {
  // Reads happen on the root client; every write must happen on the transaction
  // client handed to the $transaction callback. Splitting them is what lets this
  // suite assert "one transaction" and "nothing was written" mechanically.
  const tx = {
    evidence: {
      findFirst: async ({ where }: { where: Row }) =>
        stored.evidence.find(row => row.workspaceId === where.workspaceId && row.findingKey === where.findingKey) ?? null,
      create: async ({ data }: { data: Row }) => {
        const row = { id: `evidence-${stored.evidence.length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...data }
        stored.evidence.push(row)
        return row
      },
    },
    evidenceResearchSource: {
      createMany: async ({ data }: { data: Row[] }) => {
        stored.sources.push(...data)
        return { count: data.length }
      },
      findMany: async ({ where }: { where: Row }) => stored.sources.filter(row => row.evidenceId === where.evidenceId),
    },
    opportunity: { findFirst: (async () => ({ id: OPPORTUNITY_ID, title: "Plan selection", workspaceId: WORKSPACE_ID })) as FindTarget },
    solution: { findFirst: (async () => null) as FindTarget },
    assumption: { findFirst: (async () => null) as FindTarget },
  }
  const deny = (label: string) => async () => { writesOutsideTransaction.push(label); throw new Error(`${label} ran outside a transaction`) }
  db.root = {
    researchSynthesis: { findFirst: async () => synthesisRow },
    researchTurn: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => turns.filter(turn => where.id.in.includes(turn.id as string)) },
    evidence: { create: deny("evidence.create"), findFirst: tx.evidence.findFirst },
    evidenceResearchSource: { createMany: deny("evidenceResearchSource.createMany"), findMany: tx.evidenceResearchSource.findMany },
    $transaction: async (fn: (client: unknown) => unknown) => { transactionCalls += 1; return fn(tx) },
  } as never
  return tx
}

const input = (overrides: Row = {}) => ({
  workspaceId: WORKSPACE_ID,
  researchSynthesisId: SYNTHESIS_ID,
  findingIndex: 0,
  opportunityId: OPPORTUNITY_ID,
  ...overrides,
}) as Parameters<typeof promoteResearchFindingToEvidence>[0]

beforeEach(() => {
  stored = { evidence: [], sources: [] }
  writesOutsideTransaction = []
  transactionCalls = 0
  turns = savedTurns()
  synthesisRow = {
    id: SYNTHESIS_ID,
    studyId: STUDY_ID,
    kind: "CROSS_SESSION",
    content: synthesisDocument(),
    study: { id: STUDY_ID, workspaceId: WORKSPACE_ID, studyType: "CUSTOMER_INTERVIEW" },
  }
  makeClient()
})

describe("researchFindingKey", () => {
  it("is a sha256 derived from the synthesis id and the finding's own content", () => {
    const key = researchFindingKey(SYNTHESIS_ID, theme())
    expect(key).toMatch(/^[a-f0-9]{64}$/)
    expect(researchFindingKey(SYNTHESIS_ID, theme())).toBe(key)
  })

  it("changes when the finding's content changes, so a key never aliases a different finding", () => {
    const edited = { ...theme(), description: "A materially different reading." }
    expect(researchFindingKey(SYNTHESIS_ID, edited)).not.toBe(researchFindingKey(SYNTHESIS_ID, theme()))
  })

  it("changes when the proposing synthesis changes, so a regenerated document promotes separately", () => {
    expect(researchFindingKey("99999999-9999-4999-8999-999999999999", theme())).not.toBe(researchFindingKey(SYNTHESIS_ID, theme()))
  })

  it("distinguishes two findings that differ only in which turns they quote", () => {
    const swapped = { ...theme(), quotes: [theme().quotes[1], theme().quotes[0]] }
    expect(researchFindingKey(SYNTHESIS_ID, swapped)).not.toBe(researchFindingKey(SYNTHESIS_ID, theme()))
  })
})

describe("promoteResearchFindingToEvidence", () => {
  it("writes Evidence and one source row per cited turn in a single transaction", async () => {
    const result = await promoteResearchFindingToEvidence(input())

    expect(transactionCalls).toBe(1)
    expect(writesOutsideTransaction).toEqual([])
    expect(stored.evidence).toHaveLength(1)
    expect(stored.evidence[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      opportunityId: OPPORTUNITY_ID,
      solutionId: undefined,
      assumptionId: undefined,
      sourceType: "interview",
      confidence: "medium",
      researchSynthesisId: SYNTHESIS_ID,
      findingKey: researchFindingKey(SYNTHESIS_ID, theme()),
    })
    // The excerpt is the finding's own words, not caller-supplied prose: that is
    // what makes the stored text and its cited turns provably the same claim.
    expect(stored.evidence[0].excerpt).toContain("Pricing is where planning stalls")
    expect(stored.sources.map(row => row.researchTurnId)).toEqual(["turn-1", "turn-2"])
    expect(stored.sources.every(row => row.evidenceId === stored.evidence[0].id)).toBe(true)
    expect(stored.sources.every(row => row.researchAttachmentId === null)).toBe(true)
    expect(result.replayed).toBe(false)
    expect(result.sourceTurnIds).toEqual(["turn-1", "turn-2"])
  })

  it("cites a turn once even when the finding quotes it twice", async () => {
    const twice = { ...theme(), quotes: [theme().quotes[0], { sessionId: "session-1", turnId: "turn-1", text: "every time" }] }
    synthesisRow!.content = synthesisDocument([twice])
    await promoteResearchFindingToEvidence(input())
    expect(stored.sources.map(row => row.researchTurnId)).toEqual(["turn-1"])
  })

  it("honours an explicit confidence and a solution target", async () => {
    const tx = makeClient()
    tx.solution.findFirst = async () => ({ id: "solution-1", title: "Plan comparison", workspaceId: WORKSPACE_ID })
    await promoteResearchFindingToEvidence(input({ opportunityId: undefined, solutionId: "solution-1", confidence: "high" }))
    expect(stored.evidence[0]).toMatchObject({ solutionId: "solution-1", opportunityId: undefined, confidence: "high" })
  })

  it("requires exactly one discovery target", async () => {
    await expect(promoteResearchFindingToEvidence(input({ solutionId: "solution-1" }))).rejects.toThrow(ResearchPromotionError)
    await expect(promoteResearchFindingToEvidence(input({ opportunityId: undefined }))).rejects.toThrow(/exactly one/i)
    expect(stored.evidence).toHaveLength(0)
  })
})

describe("replay convergence (the withInterviewMutation payload-hash pattern)", () => {
  it("returns the existing row for an identical retry without writing a second one", async () => {
    const first = await promoteResearchFindingToEvidence(input())
    const second = await promoteResearchFindingToEvidence(input())

    expect(second.replayed).toBe(true)
    expect(second.evidence.id).toBe(first.evidence.id)
    expect(stored.evidence).toHaveLength(1)
    expect(stored.sources).toHaveLength(2)
  })

  it("refuses a different payload under the same finding key rather than overwriting", async () => {
    const tx = makeClient()
    await promoteResearchFindingToEvidence(input())
    tx.solution.findFirst = async () => ({ id: "solution-1", title: "Plan comparison", workspaceId: WORKSPACE_ID })

    await expect(promoteResearchFindingToEvidence(input({ opportunityId: undefined, solutionId: "solution-1" })))
      .rejects.toThrow(/already promoted/i)
    await expect(promoteResearchFindingToEvidence(input({ confidence: "low" }))).rejects.toThrow(/already promoted/i)

    expect(stored.evidence).toHaveLength(1)
    expect(stored.evidence[0]).toMatchObject({ opportunityId: OPPORTUNITY_ID, confidence: "medium" })
  })

  it("treats a regenerated synthesis as a separate promotion, because provenance differs", async () => {
    await promoteResearchFindingToEvidence(input())
    const regeneratedId = "66666666-6666-4666-8666-666666666666"
    synthesisRow = { ...synthesisRow!, id: regeneratedId }

    const second = await promoteResearchFindingToEvidence(input({ researchSynthesisId: regeneratedId }))
    expect(second.replayed).toBe(false)
    expect(stored.evidence).toHaveLength(2)
    expect(stored.evidence.map(row => row.researchSynthesisId)).toEqual([SYNTHESIS_ID, regeneratedId])
  })
})

describe("grounding: cited turns are re-resolved, never trusted", () => {
  it("rejects a finding whose cited turn no longer exists, writing nothing", async () => {
    turns = savedTurns().filter(turn => turn.id !== "turn-2")
    await expect(promoteResearchFindingToEvidence(input())).rejects.toThrow(/saved participant turn/i)
    expect(stored.evidence).toEqual([])
    expect(stored.sources).toEqual([])
    expect(transactionCalls).toBe(0)
  })

  it("rejects a cited turn that belongs to another study", async () => {
    // researchTurn.findMany is scoped to the synthesis's own study, so a turn in
    // another study simply does not come back — the same shape as a deletion.
    db.root = { ...(db.root as object), researchTurn: { findMany: async () => [] } } as never
    await expect(promoteResearchFindingToEvidence(input())).rejects.toThrow(/saved participant turn/i)
    expect(stored.evidence).toEqual([])
  })

  it("scopes the turn lookup to the cited synthesis's study", async () => {
    const findMany = vi.fn(async (query: Row) => savedTurns().filter(turn => (query.where as { id: { in: string[] } }).id.in.includes(turn.id)))
    db.root = { ...(db.root as object), researchTurn: { findMany } } as never
    await promoteResearchFindingToEvidence(input())
    expect(findMany.mock.calls[0][0]).toMatchObject({ where: { id: { in: ["turn-1", "turn-2"] }, session: { studyId: STUDY_ID } } })
  })

  it("rejects a quote that is no longer a verbatim substring of its saved turn", async () => {
    turns = savedTurns().map(turn => turn.id === "turn-1" ? { ...turn, content: "redacted by the participant" } : turn)
    await expect(promoteResearchFindingToEvidence(input())).rejects.toThrow(/verbatim/i)
    expect(stored.evidence).toEqual([])
  })

  it("rejects a quote whose sessionId does not match the saved turn's session", async () => {
    turns = savedTurns().map(turn => turn.id === "turn-1" ? { ...turn, sessionId: "session-9" } : turn)
    await expect(promoteResearchFindingToEvidence(input())).rejects.toThrow(/saved participant turn/i)
    expect(stored.evidence).toEqual([])
  })

  it("rejects a cited turn that is not participant speech", async () => {
    turns = savedTurns().map(turn => turn.id === "turn-1" ? { ...turn, role: "INTERVIEWER" } : turn)
    await expect(promoteResearchFindingToEvidence(input())).rejects.toThrow(/saved participant turn/i)
    expect(stored.evidence).toEqual([])
  })
})

describe("synthesis resolution", () => {
  it("refuses a synthesis in another workspace even though the target is local", async () => {
    synthesisRow = { ...synthesisRow!, study: { id: STUDY_ID, workspaceId: OTHER_WORKSPACE_ID, studyType: "CUSTOMER_INTERVIEW" } }
    await expect(promoteResearchFindingToEvidence(input())).rejects.toThrow(/not found/i)
    expect(stored.evidence).toEqual([])
  })

  it("refuses a PM interview study's synthesis", async () => {
    synthesisRow = { ...synthesisRow!, study: { id: STUDY_ID, workspaceId: WORKSPACE_ID, studyType: "PM_INTERVIEW" } }
    await expect(promoteResearchFindingToEvidence(input())).rejects.toThrow(/not found/i)
  })

  it("reads only CROSS_SESSION rows, so a PENDING lease claim can never be promoted", async () => {
    const findFirst = vi.fn(async (query: Row) => (query.where as { id: string }).id === SYNTHESIS_ID ? synthesisRow : null)
    db.root = { ...(db.root as object), researchSynthesis: { findFirst } } as never
    await promoteResearchFindingToEvidence(input())
    expect(findFirst.mock.calls[0][0]).toMatchObject({ where: { id: SYNTHESIS_ID, kind: "CROSS_SESSION" } })
  })

  it("refuses a missing synthesis", async () => {
    synthesisRow = null
    await expect(promoteResearchFindingToEvidence(input())).rejects.toThrow(/not found/i)
  })

  it("refuses a finding index outside the stored document", async () => {
    await expect(promoteResearchFindingToEvidence(input({ findingIndex: 7 }))).rejects.toThrow(/finding/i)
    expect(stored.evidence).toEqual([])
  })

  it("refuses a synthesis whose stored content no longer validates", async () => {
    synthesisRow!.content = JSON.stringify({ version: 1, claimId: "claim-secret", deadline: 1 })
    await expect(promoteResearchFindingToEvidence(input())).rejects.toThrow(/could not be read/i)
  })

  it("refuses a discovery target that resolves outside the declared workspace", async () => {
    const tx = makeClient()
    tx.opportunity.findFirst = async () => null
    await expect(promoteResearchFindingToEvidence(input())).rejects.toThrow(/not found/i)
    expect(stored.evidence).toEqual([])
  })
})
