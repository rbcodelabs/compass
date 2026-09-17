/**
 * ADR-0012 step 6a — reading back the research→Evidence provenance chain.
 *
 * Step 5 (migration 052) made `promote_research_finding_to_evidence` write
 * `Evidence.researchSynthesisId` plus one `EvidenceResearchSource` row per
 * cited turn. That chain was write-only: `list_evidence` still returned the
 * pre-052 projection and no screen rendered it, so ADR-0002 invariant 6 —
 * "findings and promoted Evidence cite exact source turns" — was true in the
 * database and invisible to the humans the invariant exists for.
 *
 * This module is the one place that resolves the chain, so every read path
 * (the MCP tool, the detail panels, the Discovery evidence tab) inherits the
 * same projection and the same two boundaries.
 *
 * ## Boundary 1 — identifiers, never transcript text
 *
 * The cited `ResearchTurn.content` is deliberately NOT returned, for two
 * independent reasons.
 *
 *  - AUTHORIZATION. `list_evidence` is gated by `assertEntityAccess(nodeType,
 *    nodeId)`, an OST-node gate. The research read tools are gated by
 *    `findMemberStudy` (lib/research-study-service.ts), which additionally
 *    refuses PM_INTERVIEW studies because those have their own owner-scoped
 *    authorization path under ADR-0011. Inlining turn text here would create a
 *    second route to participant speech that bypasses the stricter gate — a
 *    widening of the research read boundary disguised as a projection change.
 *  - SIZE. `list_evidence` is unpaginated: it returns every Evidence row on a
 *    node, and a promoted finding cites up to five turns. `content` is
 *    unbounded `TEXT`. Inlining it would multiply an agent's context by the
 *    transcript, for text the agent can already fetch deliberately.
 *
 * What is returned is exactly what makes the citation *navigable and
 * verifiable*: the synthesis that proposed the finding, and for each cited
 * turn its id, its session, its study and its position in the transcript. A
 * human follows the study deep link; an agent calls `get_research_session`.
 * The verbatim quote itself already lives in the synthesis document, which
 * `list_research_syntheses` serves through its own audited exposure rules.
 *
 * ## Boundary 2 — participant PII never reaches output
 *
 * Resolving a turn walks ResearchTurn → ResearchSession → ResearchStudy, and
 * `ResearchSession` is precisely the row holding `participantName`,
 * `participantEmail`, `resumeTokenHash`, `audioUrl` and the voice/request
 * control state. The discipline is the one `publicSession()` established:
 *
 *   1. the `select` never loads those columns, AND
 *   2. `sourceView()` rebuilds its result field by field — it never spreads a
 *      database row — so widening the select, or adding a column to the model,
 *      cannot leak by default.
 *
 * Test coverage asserts against the serialized output with a deliberately fat
 * mock row, so defence (1) alone cannot make the tests pass.
 */
import getPrisma from "@/lib/db"

/**
 * One cited turn. `resolved: false` is the ADR-0012 "provenance rot" case:
 * `EvidenceResearchSource` has no database foreign key (DSQL has none), so a
 * deleted turn leaves a source row pointing at nothing. Such a citation is
 * still reported rather than silently dropped — an Evidence row that claims two
 * sources and shows one is a quieter lie than one that says a source is gone.
 */
export type EvidenceResearchSourceView = {
  researchTurnId: string
  studyId: string | null
  sessionId: string | null
  sequence: number | null
  role: string | null
  resolved: boolean
}

export type EvidenceProvenance = {
  researchSynthesisId: string
  sources: EvidenceResearchSourceView[]
}

/**
 * The minimum an Evidence row must carry to be resolved. `workspaceId` is not
 * decoration: it is the tenancy fence applied to the turn lookup below.
 */
export type ProvenanceCarrier = {
  id: string
  workspaceId: string
  researchSynthesisId: string | null
}

/**
 * Presence of provenance is keyed on `researchSynthesisId`, the single column
 * promotion always writes alongside the source rows and the one the
 * `idx_evidence_research_synthesis` index supports. Rows without it — every
 * pre-052 row and everything `add_evidence` creates — are skipped entirely, so
 * the common case costs zero extra queries.
 */
const isPromoted = (row: ProvenanceCarrier) => Boolean(row.researchSynthesisId)

const turnSelect = {
  id: true,
  sessionId: true,
  sequence: true,
  role: true,
  session: { select: { studyId: true, study: { select: { workspaceId: true } } } },
} as const

type ResolvedTurn = {
  id: string
  sessionId: string
  sequence: number
  role: string
  session: { studyId: string; study: { workspaceId: string } }
}

const unresolved = (researchTurnId: string): EvidenceResearchSourceView => ({
  researchTurnId, studyId: null, sessionId: null, sequence: null, role: null, resolved: false,
})

/** Field-by-field, never a spread. See Boundary 2. */
const sourceView = (turn: ResolvedTurn): EvidenceResearchSourceView => ({
  researchTurnId: turn.id,
  studyId: turn.session.studyId,
  sessionId: turn.sessionId,
  sequence: turn.sequence,
  role: turn.role,
  resolved: true,
})

/**
 * Stable regardless of what order the database hands back rows: resolved
 * citations first, grouped by session and then in transcript order, with the
 * turn id as the final tiebreak so two turns at the same sequence in different
 * sessions still sort deterministically. Unresolved citations sort last — they
 * have no position to sort by, and a reader should see the real sources first.
 */
function compareSources(a: EvidenceResearchSourceView, b: EvidenceResearchSourceView) {
  if (a.resolved !== b.resolved) return a.resolved ? -1 : 1
  if (a.resolved && b.resolved) {
    if (a.sessionId !== b.sessionId) return a.sessionId! < b.sessionId! ? -1 : 1
    if (a.sequence !== b.sequence) return a.sequence! - b.sequence!
  }
  return a.researchTurnId < b.researchTurnId ? -1 : a.researchTurnId > b.researchTurnId ? 1 : 0
}

/**
 * Resolve provenance for a batch of Evidence rows. Two queries at most, and
 * none at all when no row in the batch was promoted.
 *
 * TENANCY. The turn lookup is filtered to the workspaces the Evidence rows
 * themselves belong to, and the per-row assembly re-checks each turn's study
 * workspace against that row's own workspace. The turn ids come from rows
 * Compass wrote itself, so neither check should ever fire — but there is no
 * foreign key holding them to a study, and a read path that renders a turn id
 * as a link into a capture study is exactly where a stale or mis-written id
 * would become a cross-tenant pointer. Failing to resolve is the safe outcome.
 */
export async function loadEvidenceProvenance(
  rows: readonly ProvenanceCarrier[]
): Promise<Map<string, EvidenceProvenance>> {
  const promoted = rows.filter(isPromoted)
  if (!promoted.length) return new Map()

  const prisma = getPrisma()
  const sources = await prisma.evidenceResearchSource.findMany({
    where: { evidenceId: { in: promoted.map(row => row.id) } },
    select: { evidenceId: true, researchTurnId: true },
  })
  if (!sources.length) {
    return new Map(promoted.map(row => [row.id, { researchSynthesisId: row.researchSynthesisId!, sources: [] }]))
  }

  const workspaceIds = [...new Set(promoted.map(row => row.workspaceId))]
  const turnIds = [...new Set(sources.map(source => source.researchTurnId))]
  const turns = (await prisma.researchTurn.findMany({
    where: { id: { in: turnIds }, session: { study: { workspaceId: { in: workspaceIds } } } },
    select: turnSelect,
  })) as unknown as ResolvedTurn[]
  const turnById = new Map(turns.map(turn => [turn.id, turn]))

  const citedByEvidence = new Map<string, string[]>()
  for (const source of sources) {
    const cited = citedByEvidence.get(source.evidenceId) ?? []
    cited.push(source.researchTurnId)
    citedByEvidence.set(source.evidenceId, cited)
  }

  return new Map(promoted.map(row => {
    const cited = citedByEvidence.get(row.id) ?? []
    const views = cited.map(turnId => {
      const turn = turnById.get(turnId)
      if (!turn || turn.session.study.workspaceId !== row.workspaceId) return unresolved(turnId)
      return sourceView(turn)
    })
    return [row.id, { researchSynthesisId: row.researchSynthesisId!, sources: views.sort(compareSources) }]
  }))
}

/**
 * Attach provenance to rows that have it, and leave every other row's object
 * identity and key set exactly as it was. Callers rely on the second half:
 * a non-promoted Evidence row must serialize, and render, byte-identically to
 * how it did before this feature existed.
 */
export function withEvidenceProvenance<T extends ProvenanceCarrier>(
  rows: readonly T[],
  provenance: Map<string, EvidenceProvenance>
): Array<T | (T & { research: EvidenceProvenance })> {
  return rows.map(row => {
    const research = provenance.get(row.id)
    return research ? { ...row, research } : row
  })
}
