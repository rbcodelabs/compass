import getPrisma from "@/lib/db"
import { isResearchCaptureEnabled } from "@/lib/research-feature"
import { ResearchAnalysisError } from "@/lib/research-analysis-service"

/**
 * "Generate synthesis" as a core-agent handoff (ADR-0012 step 4).
 *
 * Mirrors `completePmInterview`'s shape: create exactly one `AgentConversation`
 * carrying a PENDING processing claim, and return where to send the browser.
 * The conversation is what the agent-turn route claims, what mints the
 * `RESEARCH_SYNTHESIS`-scoped MCP credential, and what binds every tool call to
 * `studyId`.
 *
 * IDEMPOTENCY. The PM kind links one conversation to an interview forever via
 * `PMInterview.agentConversationId`, because an interview resolves once.
 * Research is not like that: regenerating a synthesis after more sessions land
 * is the normal case, and `SynthesisResults` already presents snapshots as a
 * history. There is also no column to hold such a link, and ADR-0012 step 4
 * permits no schema change — so per-study one-conversation-forever is neither
 * required nor available.
 *
 * What actually must not duplicate is *generation*, and that is guarded a layer
 * down and race-free: `withSynthesisLease` refuses a second concurrent claim
 * with "Synthesis already in progress" (409) and serializes claimants through
 * the study row's optimistic `updatedAt`. So the worst a double-click can
 * produce is a second conversation whose claimed turn hits that 409 — one extra
 * conversation row, never a second synthesis. Trading that for a schema change
 * would be the wrong way round.
 */
export async function startStudySynthesisHandoff(studyId: string, userId: string) {
  if (!isResearchCaptureEnabled()) throw new ResearchAnalysisError("Study not found", 404)
  if (!userId) throw new ResearchAnalysisError("Authentication required", 401)
  const prisma = getPrisma()
  const study = await prisma.researchStudy.findFirst({
    where: { id: studyId, workspace: { members: { some: { userId } } } },
    select: { id: true, studyType: true, workspaceId: true, workspace: { select: { slug: true, organization: { select: { slug: true } } } } },
  })
  // PM interviews reuse these tables but have their own owner-scoped handoff
  // (ADR-0011); routing one through here would hand a RESEARCH_SYNTHESIS claim
  // read access to a PM transcript. Indistinguishable from "no such study", so
  // membership and existence do not leak either.
  if (!study || study.studyType === "PM_INTERVIEW") throw new ResearchAnalysisError("Study not found", 404)
  // Without a COMPLETED session the synthesis can only ever fail at
  // `assertSourceSize` — but not before a whole agent turn has been spent booting
  // a sandbox and reading. Fail here in milliseconds instead of minting a
  // conversation that is guaranteed to fail.
  if (await prisma.researchSession.count({ where: { studyId: study.id, status: "COMPLETED" } }) === 0) {
    throw new ResearchAnalysisError("No completed interviews to synthesize yet. Complete an interview, then generate findings.", 422)
  }
  const basePath = `/${study.workspace.organization.slug}/${study.workspace.slug}`
  const conversation = await prisma.agentConversation.create({
    data: {
      workspaceId: study.workspaceId,
      userId,
      title: "Synthesize saved research",
      interviewProcessingJson: JSON.stringify({ status: "PENDING", kind: "RESEARCH_SYNTHESIS", studyId: study.id, targetUrl: `${basePath}/capture/studies/${study.id}` }),
      updatedAt: new Date(),
    },
    select: { id: true },
  })
  return { conversationId: conversation.id, conversationUrl: `${basePath}/agent?c=${conversation.id}` }
}
