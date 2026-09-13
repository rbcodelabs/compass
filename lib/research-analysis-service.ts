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

export async function generateStudySynthesis(studyId: string, userId: string) {
  if (!userId) throw new ResearchAnalysisError("Authentication required", 401)
  const prisma = getPrisma()
  const study = await studyAccess(studyId, userId)
  const sessions = await prisma.researchSession.findMany({ where: { studyId, status: "COMPLETED" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 501, include: { turns: { orderBy: { sequence: "asc" }, take: 2_001 } } })
  const source: AnalysisSource = { goal: study.goal, guide: deserializeResearchGuide(study.guide), sessions: sessions.map(session => ({ id: session.id, modality: session.modality, turns: session.turns.map(({ id, role, content, sequence }) => ({ id, role, content, sequence })) })) }
  assertSourceSize(source)
  const prompt = buildAnalysisPrompt("synthesis", source)
  const startedAt = Date.now()
  const deadline = startedAt + analysisOperationMs
  const claimContent = JSON.stringify({ version: 1, sourceFingerprint: analysisFingerprint(source), claimId: randomUUID(), deadline })
  const pending = await prisma.$transaction(async tx => {
    const running = await tx.researchSynthesis.findFirst({ where: { studyId, kind: "PENDING", createdAt: { gt: new Date(Date.now() - leaseMs) } } })
    if (running) throw new ResearchAnalysisError("Synthesis already in progress", 409)
    // Serialize claims through the existing study row; no unique index or schema change.
    const claim = await tx.researchStudy.updateMany({ where: { id: studyId, updatedAt: study.updatedAt }, data: { updatedAt: new Date(Math.max(Date.now(), study.updatedAt.getTime() + 1)) } })
    if (claim.count !== 1) throw new ResearchAnalysisError("Study changed; refresh before generating", 409)
    return tx.researchSynthesis.create({ data: { studyId, kind: "PENDING", content: claimContent, sessionCount: sessions.length, promptVersion: "research-analysis-v1", createdAt: new Date(startedAt) } })
  })
  const pendingWhere = { id: pending.id, studyId, kind: "PENDING", content: claimContent }
  try {
    const result = parseAnalysisResult("synthesis", await analysisResponse("synthesis", prompt, source, deadline), source)
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

async function analysisResponse(kind: "summary" | "coverage" | "synthesis", prompt: string, source: AnalysisSource, deadline: number) {
  assertAnalysisDeadline(deadline)
  if (process.env.NODE_ENV !== "production" && process.env.E2E_FUNCTIONAL === "1" && process.env.E2E_ISOLATED_DATABASE === "1") {
    const evidence = source.sessions.flatMap(session => session.turns.filter(turn => turn.role === "PARTICIPANT" && turn.content.trim()).map(turn => ({ sessionId: session.id, ...turn })))
    const first = evidence[0]
    if (kind === "summary") return JSON.stringify({ summary: "Test analysis: participant described their experience.", evidenceTurnIds: [first.id] })
    if (kind === "coverage") return JSON.stringify({ coverage: source.guide.map(item => ({ guideItemId: item.id, covered: false, evidenceTurnIds: [] })) })
    return JSON.stringify({ summary: "Test synthesis from saved sessions.", themes: [{ title: "Saved participant evidence", description: "A fixture finding.", surprising: false, quotes: [{ sessionId: first.sessionId, turnId: first.id, text: first.content }] }], patterns: [], jobs: [], recommendations: [] })
  }
  return runResearchAnalysisAgent(prompt, deadline)
}
