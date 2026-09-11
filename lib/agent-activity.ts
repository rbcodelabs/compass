import getPrisma from "@/lib/db"
import { McpAuthzError, type McpActor } from "@/lib/mcp-authz"

/** Start before execution. A final logging failure must never cause a mutation retry. */
export async function withAgentActivity<T>(actor: McpActor, toolName: string, mutation: boolean, gate: () => Promise<void>, operation: () => Promise<T>): Promise<T> {
  if (actor.purpose !== "AGENT" || !mutation) { await gate(); return operation() }
  if (!actor.agentId || !actor.userId || !actor.credentialId) throw new McpAuthzError("Incomplete agent identity.")
  const prisma = getPrisma()
  const row = await prisma.agentToolCall.create({ data: { agentId: actor.agentId, userId: actor.userId, credentialId: actor.credentialId, toolName, status: "STARTED" }, select: { id: true } })
  const finish = async (status: string) => {
    try { await prisma.agentToolCall.update({ where: { id: row.id }, data: { status, workspaceId: actor.authorizedWorkspaceId, finishedAt: new Date() } }) }
    catch { console.error("Unable to record agent operation outcome", { operationId: row.id }) }
  }
  try { await gate() } catch (error) { await finish("DENIED"); throw error }
  try {
    const result = await operation()
    const envelope = result as { isError?: boolean; structuredContent?: { ok?: boolean } } | null
    const failed = envelope?.isError === true || envelope?.structuredContent?.ok === false
    await finish(failed ? "FAILED" : "SUCCEEDED")
    return result
  } catch (error) { await finish("FAILED"); throw error }
}
