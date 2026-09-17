import { randomUUID } from "node:crypto"
import getPrisma from "@/lib/db"
import { deserializeResearchGuide } from "@/lib/research"
import { analysisFingerprint, buildAnalysisPrompt, parseAnalysisResult, readSessionAnalysis, type AnalysisSource, type SessionAnalysis } from "@/lib/research-analysis"
import { runResearchAnalysisAgent } from "@/lib/research-analysis-agent"
import { analysisOperationMs, assertAnalysisDeadline } from "@/lib/research-analysis-deadline"

export class ResearchAnalysisError extends Error {
  constructor(message: string, public status = 422) { super(message) }
}
type StoredSessionAnalysis = SessionAnalysis & { pending?: { id: string; startedAt: string }; failed?: string }
const leaseMs = 180_000

async function studyAccess(studyId: string, userId?: string) {
  const study = await getPrisma().researchStudy.findFirst({
    where: { id: studyId, ...(userId ? { workspace: { members: { some: { userId } } } } : {}) },
  })
  if (!study || study.studyType === "PM_INTERVIEW") throw new ResearchAnalysisError("Study not found", 404)
  return study
}

function assertSourceSize(source: AnalysisSource) {
  if (source.sessions.length > 500 || source.sessions.some(session => session.turns.length > 2_000)) throw new ResearchAnalysisError("Research is too large for one analysis; nothing was truncated")
  if (!source.sessions.some(session => session.turns.some(turn => turn.role === "PARTICIPANT" && turn.content.trim()))) throw new ResearchAnalysisError("No saved participant responses to analyze")
}

/** Internal completion caller omits userId only after participant completion has succeeded. */
export async function generateSessionAnalysis({ studyId, sessionId, kind, userId, automatic = false, regenerate = false }: { studyId: string; sessionId: string; kind: "summary" | "coverage"; userId?: string; automatic?: boolean; regenerate?: boolean }) {
  if (!userId && !automatic) throw new ResearchAnalysisError("Authentication required", 401)
  const prisma = getPrisma()
  const study = await studyAccess(studyId, userId)
  const session = await prisma.researchSession.findFirst({ where: { id: sessionId, studyId }, include: { turns: { orderBy: { sequence: "asc" }, take: 2_001 } } })
  if (!session || session.status !== "COMPLETED") throw new ResearchAnalysisError("Only completed interviews can be analyzed")
  // Automatic completion replay never allocates another model call after any receipt.
  if (automatic && session.summary !== null) return null
  const source: AnalysisSource = { goal: study.goal, guide: deserializeResearchGuide(study.guide), sessions: [{ id: session.id, modality: session.modality, turns: session.turns.map(({ id, role, content, sequence }) => ({ id, role, content, sequence })) }] }
  assertSourceSize(source)
  const prompt = buildAnalysisPrompt(kind, source)
  const previous = readSessionAnalysis(session.summary)
  const existing = previous.analysis ?? { version: 1 as const, ...(previous.summary ? { legacySummary: previous.summary } : {}) }
  const cached = existing[kind]
  if (!regenerate && cached?.sourceFingerprint === analysisFingerprint(source)) return cached
  let prior: StoredSessionAnalysis = existing
  try { prior = { ...existing, pending: session.summary ? JSON.parse(session.summary).pending : undefined } } catch { /* Legacy plaintext is preserved until successful regeneration. */ }
  if (prior.pending && Date.now() - Date.parse(prior.pending.startedAt) < leaseMs) throw new ResearchAnalysisError("Analysis already in progress", 409)
  const startedAt = Date.now()
  const deadline = startedAt + analysisOperationMs
  const claim = JSON.stringify({ ...existing, pending: { id: randomUUID(), startedAt: new Date(startedAt).toISOString() } })
  const claimed = await prisma.researchSession.updateMany({ where: { id: sessionId, studyId, status: "COMPLETED", summary: session.summary }, data: { summary: claim, updatedAt: new Date() } })
  if (claimed.count !== 1) throw new ResearchAnalysisError("Analysis already in progress", 409)
  try {
    const result = parseAnalysisResult(kind, await analysisResponse(kind, prompt, source, deadline), source)
    assertAnalysisDeadline(deadline)
    const saved = await prisma.researchSession.updateMany({ where: { id: sessionId, studyId, status: "COMPLETED", summary: claim }, data: { summary: JSON.stringify({ ...existing, [kind]: result }), updatedAt: new Date() } })
    if (saved.count !== 1) throw new ResearchAnalysisError("Analysis changed; refresh before retrying", 409)
    return result
  } catch (error) {
    await prisma.researchSession.updateMany({ where: { id: sessionId, studyId, summary: claim }, data: { summary: JSON.stringify({ ...existing, failed: kind }), updatedAt: new Date() } })
    if (error instanceof ResearchAnalysisError) throw error
    throw new ResearchAnalysisError("Analysis unavailable; the saved interview is unchanged. Retry from results.", 502)
  }
}

/**
 * Everything the lease needs, read and validated *before* a PENDING row exists.
 *
 * Split out at ADR-0012 step 4 so the agent-authored path can reuse the claim /
 * validate / store machinery without reusing the standalone pipeline that step 6
 * then retired. Any check that must fail *before* a PENDING row exists belongs
 * between this call and `withSynthesisLease` — `storeAgentStudySynthesis` puts
 * its document-size ceiling there for exactly that reason.
 */
export type LoadedSynthesisSource = { study: Awaited<ReturnType<typeof studyAccess>>; sessionCount: number; source: AnalysisSource }

export async function loadSynthesisSource(studyId: string, userId: string): Promise<LoadedSynthesisSource> {
  if (!userId) throw new ResearchAnalysisError("Authentication required", 401)
  const prisma = getPrisma()
  const study = await studyAccess(studyId, userId)
  const sessions = await prisma.researchSession.findMany({ where: { studyId, status: "COMPLETED" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 501, include: { turns: { orderBy: { sequence: "asc" }, take: 2_001 } } })
  const source: AnalysisSource = { goal: study.goal, guide: deserializeResearchGuide(study.guide), sessions: sessions.map(session => ({ id: session.id, modality: session.modality, turns: session.turns.map(({ id, role, content, sequence }) => ({ id, role, content, sequence })) })) }
  assertSourceSize(source)
  return { study, sessionCount: sessions.length, source }
}

/**
 * The retry-safe `ResearchSynthesis` lease (`PENDING` → `CROSS_SESSION` |
 * `FAILED`) that ADR-0012 requires be preserved rather than replaced.
 *
 * `produce` returns the raw analysis JSON. Since ADR-0012 step 6 retired the
 * standalone pipeline the only producer is the MCP tool, which hands back the
 * core agent's own document — still untrusted until `parseAnalysisResult` has
 * validated it against `source`, which is rebuilt from saved rows here and
 * never supplied by the producer.
 *
 * `surfaceFailureDetail` stays opt-in rather than becoming the only behaviour.
 * It is safe for the agent path because those failures are this module's own
 * validation messages about a document the agent itself wrote, so surfacing
 * them is what lets the agent correct its citations instead of retrying blind.
 * A producer that can throw provider or infrastructure text — which the retired
 * one could — must not get that treatment, so the default stays fixed wording.
 */
export async function withSynthesisLease(
  { study, sessionCount, source }: LoadedSynthesisSource,
  produce: (source: AnalysisSource, deadline: number) => Promise<string>,
  { surfaceFailureDetail = false }: { surfaceFailureDetail?: boolean } = {},
) {
  const prisma = getPrisma()
  const studyId = study.id
  const startedAt = Date.now()
  const deadline = startedAt + analysisOperationMs
  const claimContent = JSON.stringify({ version: 1, sourceFingerprint: analysisFingerprint(source), claimId: randomUUID(), deadline })
  const pending = await prisma.$transaction(async tx => {
    const running = await tx.researchSynthesis.findFirst({ where: { studyId, kind: "PENDING", createdAt: { gt: new Date(Date.now() - leaseMs) } } })
    if (running) throw new ResearchAnalysisError("Synthesis already in progress", 409)
    // Serialize claims through the existing study row; no unique index or schema change.
    const claim = await tx.researchStudy.updateMany({ where: { id: studyId, updatedAt: study.updatedAt }, data: { updatedAt: new Date(Math.max(Date.now(), study.updatedAt.getTime() + 1)) } })
    if (claim.count !== 1) throw new ResearchAnalysisError("Study changed; refresh before generating", 409)
    return tx.researchSynthesis.create({ data: { studyId, kind: "PENDING", content: claimContent, sessionCount, promptVersion: "research-analysis-v1", createdAt: new Date(startedAt) } })
  })
  const pendingWhere = { id: pending.id, studyId, kind: "PENDING", content: claimContent }
  try {
    let result
    try {
      result = parseAnalysisResult("synthesis", await produce(source, deadline), source)
    } catch (error) {
      // Only THIS call's message may ever be surfaced. It is either a hand-written
      // grounding-check message from lib/research-analysis.ts or a zod issue about
      // the caller's own document — never provider text and never database detail.
      // Everything further down (the deadline assertion and both writes) stays on
      // the fixed wording below, so a Prisma error cannot reach the model.
      if (surfaceFailureDetail && !(error instanceof ResearchAnalysisError)) {
        throw new ResearchAnalysisError(error instanceof Error ? error.message : "Synthesis was rejected; nothing was stored.", 422)
      }
      throw error
    }
    assertAnalysisDeadline(deadline)
    const saved = await prisma.researchSynthesis.updateMany({ where: pendingWhere, data: { kind: "CROSS_SESSION", content: JSON.stringify(result), model: "claude-sonnet-5", updatedAt: new Date() } })
    if (saved.count !== 1) throw new ResearchAnalysisError("Synthesis changed; refresh before retrying", 409)
    return result
  } catch (error) {
    await prisma.researchSynthesis.updateMany({ where: pendingWhere, data: { kind: "FAILED", updatedAt: new Date() } })
    if (error instanceof ResearchAnalysisError) throw error
    throw new ResearchAnalysisError("Synthesis unavailable; previous results are unchanged. Retry generation.", 502)
  }
}

/**
 * ADR-0012 step 4. The core agent has already done the reasoning, using the
 * step-3 transcript tools and its workspace's capability-pack methodology; this
 * only validates and stores. No nested model call — wrapping the retired
 * pipeline would keep two reasoning stacks, which is the thing being removed.
 */
export async function storeAgentStudySynthesis(studyId: string, userId: string, synthesis: unknown) {
  const raw = JSON.stringify(synthesis)
  // `synthesisSchema` admits a document far larger than parseAnalysisResult's
  // 100,000-char ceiling, so check it here — before the lease. Otherwise a
  // schema-valid but oversized submission would claim a PENDING row and bump the
  // study's `updatedAt` only to fail, which is the one failure mode the caller
  // can fix by writing less.
  if (raw.length > 100_000) throw new ResearchAnalysisError("Synthesis document is too large; shorten the descriptions and quotes and submit again.", 422)
  const loaded = await loadSynthesisSource(studyId, userId)
  return withSynthesisLease(loaded, async () => raw, { surfaceFailureDetail: true })
}

/**
 * The bounded per-session producer. ADR-0012 step 4 moved cross-session
 * synthesis to the core agent and step 6 removed the legacy producer that
 * reached this with `"synthesis"`, so only summary and coverage remain.
 */
async function analysisResponse(kind: "summary" | "coverage", prompt: string, source: AnalysisSource, deadline: number) {
  assertAnalysisDeadline(deadline)
  if (process.env.NODE_ENV !== "production" && process.env.E2E_FUNCTIONAL === "1" && process.env.E2E_ISOLATED_DATABASE === "1") {
    if (kind === "coverage") return JSON.stringify({ coverage: source.guide.map(item => ({ guideItemId: item.id, covered: false, evidenceTurnIds: [] })) })
    const first = source.sessions.flatMap(session => session.turns.filter(turn => turn.role === "PARTICIPANT" && turn.content.trim()))[0]
    return JSON.stringify({ summary: "Test analysis: participant described their experience.", evidenceTurnIds: [first.id] })
  }
  return runResearchAnalysisAgent(prompt, deadline)
}
