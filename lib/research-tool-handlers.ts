import { getMcpActor, isServiceActor, McpAuthzError } from "@/lib/mcp-authz"
import { ok, fail, type ToolResult } from "@/lib/mcp-output"
import { CompassUrlNotConfiguredError, researchParticipantUrl } from "@/lib/compass-url"
import * as studies from "@/lib/research-study-service"
import type { ResearchStudyType } from "@/lib/research"

type Scope = { workspaceId: string }
type Study = Scope & { studyId: string }
async function invoke(operation: (actor: studies.ResearchStudyActor) => Promise<ToolResult>) {
  const actor = getMcpActor()
  if (actor.purpose === "RESEARCH") throw new McpAuthzError("Tool is not available to research interviews")
  try { return await operation({ userId: actor.userId, service: isServiceActor(actor), source: "MCP" }) }
  catch (error) { return fail(error instanceof studies.ResearchStudyError ? error.message : "Research operation failed; no internal details are exposed. Refresh the study before retrying a mutation.") }
}
/**
 * The study/link mutation itself always succeeds in the database regardless of
 * whether a human-facing participant URL can be built, so a *missing* URL
 * config degrades to `null` here rather than failing the whole MCP tool call —
 * mirroring `buildReviewUrl` in lib/decision-tool-handlers.ts. An unsafe
 * *configured* origin is a different, more serious failure and still aborts
 * the call (see lib/compass-url.ts's CompassUrlNotConfiguredError).
 */
function safeParticipantUrl(token: string): string | null {
  try {
    return researchParticipantUrl(token)
  } catch (error) {
    if (error instanceof CompassUrlNotConfiguredError) return null
    throw error
  }
}
function mutation(message: string, result: { id: string; token?: string; status?: string }) {
  const participantUrl = result.token ? safeParticipantUrl(result.token) : null
  const data = { id: result.id, ...(result.status ? { status: result.status } : {}), ...(result.token ? { participantUrl } : {}) }
  const participantUrlLine = participantUrl ?? "unavailable (production URL not configured)"
  return ok(`${message}\nID: ${result.id}${result.token ? `\nParticipant link (shown only now): ${participantUrlLine}` : ""}`, data)
}
export async function generateResearchGuideTool(input: Scope & { studyType: ResearchStudyType; goal: string; appUrl?: string; targetMinutes: number }) {
  const deadline = Date.now() + 45_000
  return invoke(async actor => ok("Editable research guide generated; review before creating a study.", { guide: await studies.generateResearchGuide({ workspaceId: input.workspaceId }, actor, { ...input, appUrl: input.appUrl ?? "" }, deadline) }))
}
export async function createResearchStudyTool(input: Scope & studies.ResearchStudyInput) {
  return invoke(async actor => mutation("Research study created.", await studies.createResearchStudy({ workspaceId: input.workspaceId }, actor, input)))
}
export async function updateResearchStudyTool(input: Study & studies.ResearchStudyInput) {
  return invoke(async actor => mutation("Research study updated. Protocol fields remain locked after the first session.", await studies.updateResearchStudy({ workspaceId: input.workspaceId }, actor, input.studyId, input)))
}
export async function listResearchStudiesTool(input: Scope & { limit?: number; status?: "DRAFT" | "ACTIVE" | "CLOSED" | "ARCHIVED"; cursor?: string }) {
  return invoke(async actor => {
    const data = await studies.listResearchStudies({ workspaceId: input.workspaceId }, actor, input)
    return ok(`${data.count} research studies on this page.`, data)
  })
}
export async function getResearchStudyTool(input: Study) {
  return invoke(async actor => {
    const data = await studies.getResearchStudy({ workspaceId: input.workspaceId }, actor, input.studyId)
    return ok(`Research study metadata.\nID: ${data.id}`, data)
  })
}
export async function activateResearchStudyTool(input: Study) {
  return invoke(async actor => mutation("Research study activated.", await studies.activateResearchStudy({ workspaceId: input.workspaceId }, actor, input.studyId)))
}
export async function closeResearchStudyTool(input: Study) {
  return invoke(async actor => mutation("Research study closed; participant links revoked.", await studies.closeResearchStudy({ workspaceId: input.workspaceId }, actor, input.studyId)))
}
export async function archiveResearchStudyTool(input: Study) {
  return invoke(async actor => mutation("Research study archived; existing research retained.", await studies.archiveResearchStudy({ workspaceId: input.workspaceId }, actor, input.studyId)))
}
export async function issueResearchLinkTool(input: Study) {
  return invoke(async actor => mutation("Participant link issued.", await studies.issueResearchLink({ workspaceId: input.workspaceId }, actor, input.studyId)))
}
export async function rotateResearchLinkTool(input: Study) {
  return invoke(async actor => mutation("Participant link rotated; prior links revoked.", await studies.regenerateResearchLink({ workspaceId: input.workspaceId }, actor, input.studyId)))
}
export async function revokeResearchLinksTool(input: Study) {
  return invoke(async actor => mutation("Participant links revoked.", await studies.revokeResearchLinks({ workspaceId: input.workspaceId }, actor, input.studyId)))
}
