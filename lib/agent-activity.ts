import getPrisma from "@/lib/db"
import { McpAuthzError, type McpActor } from "@/lib/mcp-authz"
import { isAgentIdentityActor } from "@/lib/agent-access"

/** Start before execution. A final logging failure must never cause a mutation retry. */
export async function withAgentActivity<T>(actor: McpActor, toolName: string, mutation: boolean, gate: () => Promise<void>, operation: () => Promise<T>): Promise<T> {
  // A personal agent key/binding, or an AGENT_TURN credential acting as a named cloud agent. For the latter, `userId` is the human who
  // invoked the run, so the row records both "which agent" and "invoked by whom". A built-in (agentless) AGENT_TURN stays unlogged here.
  if (!isAgentIdentityActor(actor) || !mutation) { await gate(); return operation() }
  if (!actor.agentId || !actor.userId || !actor.credentialId) throw new McpAuthzError("Incomplete agent identity.")
  const prisma = getPrisma()
  // credentialType defaults to API_KEY rather than being left null: every actor
  // that reaches here today comes from validateMcpAuth, which sets it on both
  // branches, and API_KEY is what the column means for every row written before
  // ADR 0015. A null would be a third value with no meaning.
  const row = await prisma.agentToolCall.create({ data: { agentId: actor.agentId, userId: actor.userId, credentialId: actor.credentialId, credentialType: actor.credentialType ?? "API_KEY", toolName, status: "STARTED" }, select: { id: true } })
  // agentAdminGrantId (ADR 0020) can only be known once `gate()` below has run
  // — hasValidAgentOrgAdminGrant sets it on `actor` only after validating a
  // live grant, and that happens inside the gate, after this row is already
  // created. So it is threaded into `finish`'s update, exactly like
  // `workspaceId: actor.authorizedWorkspaceId` above it, which has the same
  // gate-populates-the-actor shape.
  const finish = async (status: string) => {
    try { await prisma.agentToolCall.update({ where: { id: row.id }, data: { status, workspaceId: actor.authorizedWorkspaceId, agentAdminGrantId: actor.agentAdminGrantId ?? null, finishedAt: new Date() } }) }
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

/**
 * "Invoked by" for audit rows written by cloud runs. A row's `userId` is the human behind the credential; it only
 * means "invoked by" when the credential was a run's AGENT_TURN key (for a personal agent key the same field is
 * the agent's owner). So this looks the credentials up and names the user for the run-key rows only.
 */
export async function invokedByForAgentActivity<T extends { credentialId: string; credentialType?: string | null; userId: string }>(rows: T[]): Promise<Map<T, string | null>> {
  const result = new Map<T, string | null>()
  const keyRows = rows.filter((row) => (row.credentialType ?? "API_KEY") === "API_KEY")
  if (!keyRows.length) return result
  const prisma = getPrisma()
  const keys = await prisma.apiKey.findMany({ where: { id: { in: [...new Set(keyRows.map((row) => row.credentialId))] }, purpose: "AGENT_TURN" }, select: { id: true } })
  const turnKeyIds = new Set(keys.map((key) => key.id))
  const turnRows = keyRows.filter((row) => turnKeyIds.has(row.credentialId))
  if (!turnRows.length) return result
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(turnRows.map((row) => row.userId))] } }, select: { id: true, name: true, email: true } })
  const names = new Map(users.map((user) => [user.id, user.name?.trim() || user.email || "Unknown user"]))
  for (const row of turnRows) result.set(row, names.get(row.userId) ?? "Unknown user")
  return result
}
