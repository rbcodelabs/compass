import { createHash } from "node:crypto"
import getPrisma, { type AppTransactionClient } from "@/lib/db"
import { readStudySynthesis, type StudySynthesis } from "@/lib/research-analysis"

/**
 * ADR-0012 step 5 — promoting a synthesis finding into linked, source-attributed
 * Evidence. Closes the gap ADR-0002 invariant 6 named: before this, promotion
 * meant a human re-typing a URL into `add_evidence`, because `Evidence` had no
 * research provenance field at all.
 *
 * AUTHORITY. This module is deliberately unreachable from the scoped generation
 * phase. `RESEARCH_SYNTHESIS_TOOLS` in lib/research-handoff-scope.ts is a closed
 * allowlist that does not contain `promote_research_finding_to_evidence`, and
 * `gateInterviewTool` runs before every handler, so a claimed turn is refused
 * here before any code below executes. Promotion only happens in a later,
 * unscoped, user-directed turn carrying the researcher's own permissions — which
 * is how invariant 6's human review is satisfied without a bespoke approval UI.
 */
export class ResearchPromotionError extends Error {
  constructor(message: string, public status = 422) { super(message) }
}

type SynthesisFinding = StudySynthesis["themes"][number]

export type PromoteFindingInput = {
  workspaceId: string
  researchSynthesisId: string
  findingIndex: number
  opportunityId?: string
  solutionId?: string
  assumptionId?: string
  confidence?: "high" | "medium" | "low"
}

/**
 * The idempotency key (`Evidence.findingKey`).
 *
 * Synthesis themes carry no stable identifier of their own — `synthesisSchema`
 * in lib/research-analysis.ts defines a theme as `{title, description,
 * surprising, quotes[]}` with no `id` — so the key has to be derived. Two facts
 * make a derivation safe: a `ResearchSynthesis` row is written once by the lease
 * and never updated after it reaches `CROSS_SESSION`, so within one synthesis a
 * theme is stable in content AND order.
 *
 * The key is therefore `sha256(version, synthesisId, canonical finding)`:
 *
 *  - CONTENT, not position. A positional key (synthesisId + index) would be a
 *    bare pointer: it would still converge today, but it asserts nothing about
 *    WHAT was promoted, so if a synthesis ever became mutable an edited theme
 *    would silently alias onto the existing Evidence row. Content-derivation
 *    fails loudly instead — a changed finding is a new key, hence a new row.
 *  - Includes the quotes, so two findings that differ only in which turns they
 *    cite are different keys. The cited turns are the provenance.
 *  - Scoped by synthesis id, so the same wording proposed by a DIFFERENT
 *    synthesis is a different key. See the regeneration note below.
 *
 * REGENERATION IS DELIBERATELY NOT CONVERGENT. Regenerating a synthesis creates
 * a new row with a new id, so an identical-looking finding promotes to a SECOND
 * Evidence row. That is the intended behaviour, for three reasons.
 *  1. `Evidence.researchSynthesisId` is singular. A synthesis-independent key
 *     would force one row to name only one of the two documents that proposed
 *     it — silently rewriting, or silently discarding, an audited provenance
 *     claim. ADR-0002 invariant 6 exists to prevent exactly that.
 *  2. A regenerated synthesis is a different analysis, over a possibly different
 *     session set (its `sourceFingerprint` and `sourceSessionIds` differ). A
 *     finding that reads the same is still a separate reading.
 *  3. Promotion is a human act in an unscoped turn. Converging would make a
 *     researcher's deliberate promotion a silent no-op.
 * The cost is two visibly similar Evidence rows, which a human can see and
 * merge. The cost of the alternative is an Evidence row whose recorded
 * provenance does not match the document its text came from — invisible and
 * irreversible. Idempotency here means "a retry converges", not "an
 * independently regenerated analysis is deduplicated".
 */
export function researchFindingKey(synthesisId: string, finding: SynthesisFinding): string {
  const canonical = JSON.stringify([
    finding.title,
    finding.description,
    finding.surprising,
    finding.quotes.map(quote => [quote.sessionId, quote.turnId, quote.text]),
  ])
  return createHash("sha256").update(`compass:research-finding:v1\n${synthesisId}\n${canonical}`).digest("hex")
}

/**
 * The replay fence, mirroring `withInterviewMutation`'s payload hash: a stable
 * digest over everything the caller's payload determines about the stored row.
 * The stored Evidence row is its own receipt, so no extra column is needed —
 * the fingerprint is recomputed from the row on replay and compared.
 */
function promotionFingerprint(fields: {
  sourceType: string
  excerpt: string
  confidence: string
  opportunityId: string | null
  solutionId: string | null
  assumptionId: string | null
  researchSynthesisId: string | null
  sourceTurnIds: readonly string[]
}) {
  const { sourceTurnIds, ...scalars } = fields
  return createHash("sha256")
    .update(JSON.stringify([...Object.entries(scalars).sort(([a], [b]) => a.localeCompare(b)), ["sourceTurnIds", [...sourceTurnIds].sort()]]))
    .digest("hex")
}

function assertSingleTarget(input: PromoteFindingInput) {
  const targets = [input.opportunityId, input.solutionId, input.assumptionId].filter(Boolean)
  if (targets.length !== 1) {
    throw new ResearchPromotionError(`Provide exactly one of opportunityId, solutionId or assumptionId (got ${targets.length}).`)
  }
}

/**
 * The discovery target, re-resolved inside the declared workspace. The MCP gate
 * has already asserted this (lib/mcp-tool-gates.ts, on the same terms as
 * `add_evidence`); repeating it here keeps the service safe for any other caller
 * and means a target that moved between gate and write is still refused.
 */
async function findTarget(tx: AppTransactionClient, input: PromoteFindingInput, workspaceId: string) {
  if (input.opportunityId) {
    return { kind: "opportunity", node: await tx.opportunity.findFirst({ where: { id: input.opportunityId, workspaceId }, select: { id: true, title: true } }) }
  }
  if (input.solutionId) {
    return { kind: "solution", node: await tx.solution.findFirst({ where: { id: input.solutionId, opportunity: { workspaceId } }, select: { id: true, title: true } }) }
  }
  return { kind: "assumption", node: await tx.assumption.findFirst({ where: { id: input.assumptionId, solution: { opportunity: { workspaceId } } }, select: { id: true, title: true } }) }
}

/**
 * Re-grounds the finding's citations against the saved transcripts, reusing the
 * discipline `parseAnalysisResult` applies at generation time: the turn must
 * exist, be PARTICIPANT speech, sit in the session the quote names, and still
 * contain the quote verbatim.
 *
 * Re-checking at promotion time is not redundant with the generation-time check.
 * The synthesis may be days old; turns can be deleted, and the provenance rot
 * ADR-0012 names is real precisely because there are no database foreign keys to
 * catch it. Running this BEFORE the transaction opens is what guarantees a bad
 * citation writes nothing at all.
 *
 * Turn ids are never taken from the caller — the tool does not accept any. They
 * come from the stored, already-validated synthesis document, and the lookup is
 * scoped to that synthesis's own study, so a turn from another study cannot
 * resolve even if one were somehow written into the document.
 */
async function resolveFindingSources(finding: SynthesisFinding, studyId: string): Promise<string[]> {
  const cited = [...new Set(finding.quotes.map(quote => quote.turnId))]
  const turns = await getPrisma().researchTurn.findMany({
    where: { id: { in: cited }, session: { studyId } },
    select: { id: true, sessionId: true, role: true, content: true },
  })
  const saved = new Map(turns.map(turn => [turn.id, turn]))
  for (const quote of finding.quotes) {
    const turn = saved.get(quote.turnId)
    if (!turn || turn.role !== "PARTICIPANT" || turn.sessionId !== quote.sessionId) {
      throw new ResearchPromotionError("This finding cites a saved participant turn that no longer resolves in its study; regenerate the synthesis before promoting it.")
    }
    if (!turn.content.includes(quote.text)) {
      throw new ResearchPromotionError("This finding's quote is no longer a verbatim substring of its saved participant turn; regenerate the synthesis before promoting it.")
    }
  }
  return cited
}

/** Prisma's unique-constraint code, raised if two promotions race the index. */
function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002"
}

export async function promoteResearchFindingToEvidence(input: PromoteFindingInput) {
  assertSingleTarget(input)
  const prisma = getPrisma()

  // Only CROSS_SESSION rows. A PENDING or FAILED row's `content` is the lease
  // claim blob, not a synthesis (see listResearchSyntheses' exposure note), so
  // restricting the read here is both a correctness and a disclosure boundary.
  const synthesis = await prisma.researchSynthesis.findFirst({
    where: { id: input.researchSynthesisId, kind: "CROSS_SESSION" },
    select: { id: true, studyId: true, content: true, study: { select: { id: true, workspaceId: true, studyType: true } } },
  })
  // One "not found" for a missing synthesis, a foreign workspace and a PM
  // interview study alike: a caller must not learn which of the three it was.
  if (!synthesis || synthesis.study.workspaceId !== input.workspaceId || synthesis.study.studyType === "PM_INTERVIEW") {
    throw new ResearchPromotionError("Synthesis not found", 404)
  }

  const document = readStudySynthesis(synthesis.content)
  if (!document) throw new ResearchPromotionError("This synthesis could not be read as a validated document; regenerate it before promoting findings.")

  const finding = document.themes[input.findingIndex]
  if (!Number.isInteger(input.findingIndex) || input.findingIndex < 0 || !finding) {
    throw new ResearchPromotionError(`Finding ${input.findingIndex} is not in this synthesis; it has ${document.themes.length} findings.`)
  }

  const sourceTurnIds = await resolveFindingSources(finding, synthesis.studyId)
  const findingKey = researchFindingKey(synthesis.id, finding)
  // The Evidence text is the finding's own words. No caller-supplied excerpt:
  // the point of the provenance chain is that the stored text and the turns it
  // cites are provably the same claim, which a free-text override would break.
  const excerpt = `${finding.title} — ${finding.description}`
  const intended = {
    sourceType: "interview",
    excerpt,
    confidence: input.confidence ?? "medium",
    opportunityId: input.opportunityId ?? null,
    solutionId: input.solutionId ?? null,
    assumptionId: input.assumptionId ?? null,
    researchSynthesisId: synthesis.id,
  }
  const fingerprint = promotionFingerprint({ ...intended, sourceTurnIds })

  // Generic so the replayed branch returns the same row shape as the created
  // one; callers read evidence.opportunityId and friends off both.
  async function converge<T extends { id: string }>(tx: AppTransactionClient, existing: T) {
    const sources = await tx.evidenceResearchSource.findMany({ where: { evidenceId: existing.id }, select: { researchTurnId: true } })
    const row = existing as unknown as Record<string, unknown>
    const storedFingerprint = promotionFingerprint({
      sourceType: String(row.sourceType), excerpt: String(row.excerpt), confidence: String(row.confidence),
      opportunityId: (row.opportunityId as string | null) ?? null,
      solutionId: (row.solutionId as string | null) ?? null,
      assumptionId: (row.assumptionId as string | null) ?? null,
      researchSynthesisId: (row.researchSynthesisId as string | null) ?? null,
      sourceTurnIds: sources.map(source => source.researchTurnId),
    })
    if (storedFingerprint !== fingerprint) {
      throw new ResearchPromotionError("This finding was already promoted to different evidence; open the existing evidence rather than promoting it again with changed details.", 409)
    }
    return { evidence: existing, sourceTurnIds: sources.map(source => source.researchTurnId), findingKey, replayed: true as const }
  }

  const write = () => prisma.$transaction(async tx => {
    const existing = await tx.evidence.findFirst({ where: { workspaceId: input.workspaceId, findingKey } })
    if (existing) return converge(tx, existing)

    const { kind, node } = await findTarget(tx, input, input.workspaceId)
    if (!node) throw new ResearchPromotionError(`The ${kind} to promote this finding onto was not found in this workspace.`, 404)

    // Evidence and its sources commit together: a half-written promotion would
    // be an Evidence row asserting research provenance it cannot substantiate.
    const evidence = await tx.evidence.create({
      data: {
        workspaceId: input.workspaceId,
        ...intended,
        opportunityId: input.opportunityId,
        solutionId: input.solutionId,
        assumptionId: input.assumptionId,
        findingKey,
        // `updatedAt` has no @updatedAt in this schema (DSQL has no triggers);
        // @default(now()) covers creation and nothing here ever updates.
      },
    })
    await tx.evidenceResearchSource.createMany({
      data: sourceTurnIds.map(researchTurnId => ({ evidenceId: evidence.id, researchTurnId, researchAttachmentId: null })),
    })
    return { evidence, sourceTurnIds, findingKey, replayed: false as const }
  })

  try {
    return await write()
  } catch (error) {
    // Two promotions of one finding can race past the in-transaction lookup; the
    // unique (workspace_id, finding_key) index is the real fence. Losing that
    // race is still a retry, so re-read and converge rather than surfacing it.
    if (!isUniqueViolation(error)) throw error
    const existing = await prisma.evidence.findFirst({ where: { workspaceId: input.workspaceId, findingKey } })
    if (!existing) throw error
    return converge(prisma, existing)
  }
}
