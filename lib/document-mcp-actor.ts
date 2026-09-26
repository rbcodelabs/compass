import { getMcpActor } from "@/lib/mcp-authz"

/** Receipt identity comes from the authenticated request, never tool input. */
export function documentMcpActor(authorName = "MCP Agent") {
  const actor = getMcpActor()
  return {
    authorId: actor.userId,
    authorName,
    actorKey: `${actor.purpose ?? "USER"}:${actor.agentId ?? actor.userId ?? actor.credentialId ?? "SERVICE"}`,
  }
}
