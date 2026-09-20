import getPrisma from "@/lib/db"
import { McpAuthzError, type McpActor } from "@/lib/mcp-authz"

/** Start before execution. A final logging failure must never cause a mutation retry. */
export async function withAgentActivity<T>(actor: McpActor, toolName: string, mutation: boolean, gate: () => Promise<void>, operation: () => Promise<T>): Promise<T> {
  if (actor.purpose !== "AGENT" || !mutation) { await gate(); return operation() }
  if (!actor.agentId || !actor.userId || !actor.credentialId) throw new McpAuthzError("Incomplete agent identity.")
  const prisma = getPrisma()
  // credentialType defaults to API_KEY rather than being left null: every actor
  // that reaches here today comes from validateMcpAuth, which sets it on both
  // branches, and API_KEY is what the column means for every row written before
  // ADR 0015. A null would be a third value with no meaning.
  const row = await prisma.agentToolCall.create({ data: { agentId: actor.agentId, userId: actor.userId, credentialId: actor.credentialId, credentialType: actor.credentialType ?? "API_KEY", toolName, status: "STARTED" }, select: { id: true } })
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
