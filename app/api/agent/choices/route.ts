import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { listRunnableAgents } from "@/lib/agent-run-identity"
import { agentModelLabel } from "@/lib/agent-models"
import { resolveAgentHarness } from "@/lib/agent-harness"
import { agentOwnModel, deploymentDefaultModel, modelChoiceSupported, selectableTurnModels } from "@/lib/agent-turn-model"

export const dynamic = "force-dynamic"

/**
 * The agents the signed-in member can pick in a workspace, the one a run would use by default, and the models a turn may be
 * pinned to. Backs the chat's agent and model selectors and the Send to agent menu. Names the workspace by id (the chat) or by
 * slugs (the menu); either way the caller must be a member, and a non-member gets the same empty answer as a workspace with
 * no agents.
 *
 * `models` is empty when the deployment cannot honour a choice (Bedrock), which is also when the chat hides its model picker.
 * `modelLabels` names every model id the client may need to display (the options, the deployment default and each agent's own
 * model), so the client never guesses a label. The model lists carry nothing workspace-specific: the built-in assistant
 * can be pinned too.
 */
export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })
  const url = new URL(request.url)
  const workspaceId = url.searchParams.get("workspaceId")
  const orgSlug = url.searchParams.get("orgSlug")
  const workspaceSlug = url.searchParams.get("workspaceSlug")
  const prisma = getPrisma()
  const where = workspaceId
    ? { id: workspaceId, members: { some: { userId: session.user.id } } }
    : orgSlug && workspaceSlug
      ? { slug: workspaceSlug, organization: { slug: orgSlug }, members: { some: { userId: session.user.id } } }
      : null
  const workspace = where ? await prisma.workspace.findFirst({ where, select: { id: true } }) : null
  const empty = Response.json({ agents: [], defaultAgentId: null, models: [], deploymentModel: null, modelLabels: {} })
  if (!workspace) return empty
  const harness = resolveAgentHarness(process.env.AGENT_HARNESS)
  const { agents, defaultAgentId } = await listRunnableAgents(prisma, { userId: session.user.id, workspaceId: workspace.id })
  const supported = modelChoiceSupported(harness)
  const models = selectableTurnModels(harness)
  const deploymentModel = deploymentDefaultModel(harness)
  const agentList = agents.map((agent) => ({ id: agent.id, name: agent.name, shared: agent.ownerType === "WORKSPACE", model: agentOwnModel(agent.model, harness) }))
  const labelled = new Set<string>([deploymentModel, ...agentList.flatMap((agent) => (agent.model ? [agent.model] : []))])
  const modelLabels = Object.fromEntries([...labelled].map((id) => [id, agentModelLabel(id)]))
  return Response.json({ agents: agentList, defaultAgentId, models: supported ? models : [], deploymentModel, modelLabels })
}
