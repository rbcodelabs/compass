import { getMcpActor, isServiceActor, McpAuthzError } from "@/lib/mcp-authz"
import { ok, fail } from "@/lib/mcp-output"
import { ExperimentResearchLinkError, linkExperimentResearchStudy, unlinkExperimentResearchStudy, type ExperimentStudyPair } from "@/lib/experiment-research-links"

async function change(input: ExperimentStudyPair & { workspaceId: string }, operation: "link" | "unlink") {
  const actor = getMcpActor()
  if (actor.purpose === "RESEARCH" || actor.scopeConversationId || actor.scopeClaimId) throw new McpAuthzError("Relationship tools are not available to scoped research or PM interviews")
  try {
    const data = await (operation === "link" ? linkExperimentResearchStudy : unlinkExperimentResearchStudy)(
      { workspaceId: input.workspaceId }, { userId: actor.userId, service: isServiceActor(actor), source: "MCP" }, { experimentId: input.experimentId, studyId: input.studyId },
    )
    return ok(`Research study ${operation === "link" ? "linked to" : "unlinked from"} experiment. No study settings or experiment results changed.\nID: ${data.experimentId}\nStudy ID: ${data.studyId}`, data)
  } catch (error) {
    return fail(error instanceof ExperimentResearchLinkError ? error.message : "Could not change the research link. Refresh and retry.")
  }
}

export async function linkExperimentToResearchStudyTool(input: ExperimentStudyPair & { workspaceId: string }) { return change(input, "link") }
export async function unlinkExperimentFromResearchStudyTool(input: ExperimentStudyPair & { workspaceId: string }) { return change(input, "unlink") }
