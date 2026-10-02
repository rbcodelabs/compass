import { getMcpActor } from "@/lib/mcp-authz"
import type { captureWorkspaceMutation } from "@/lib/workspace-update-mutations"

export type ProgrammaticSource = "MCP" | "API"
export type WorkspaceMutationSource = Parameters<typeof captureWorkspaceMutation>[3]

/** Preserve transport provenance while deriving the same user/agent audit actor. */
export function workspaceMutationSource(source: ProgrammaticSource = "MCP"): WorkspaceMutationSource {
  if (source === "MCP") return "MCP"
  const actor = getMcpActor()
  if ((actor.purpose === "AGENT" || actor.purpose === "AGENT_TURN") && actor.agentId) {
    return { actorType: "AGENT", actorId: actor.agentId }
  }
  if ((!actor.purpose || actor.purpose === "USER") && actor.userId) {
    return { actorType: "USER", actorId: actor.userId }
  }
  return { actorType: "SYSTEM", actorId: null }
}
