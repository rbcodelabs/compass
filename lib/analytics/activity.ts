import { AsyncLocalStorage } from "node:async_hooks"
import getPrisma, { type AppPrismaClient, type AppTransactionClient } from "@/lib/db"
import { getToolPrisma, hasToolTransaction } from "@/lib/mcp-tool-db"
import { assertWorkspaceMember, getMcpActor, type McpActor } from "@/lib/mcp-authz"
import { ACTIVITY_FIELDS, activityAction, analyticsCollectionEnabled, classifyActivity, type ActivityLayer, type ActivityAction } from "./activity-policy"
import { sendActivityEvent } from "./telemetry"

type Source = "ui" | "mcp" | "agent"
type Event = { action: ActivityAction; source: Source }
const eventQueue = new AsyncLocalStorage<Event[]>()
const toolContext = new AsyncLocalStorage<boolean>()
const qualifyingTools = new Set(["create_opportunity", "update_opportunity", "update_opportunity_status", "add_solution", "update_solution", "update_solution_status", "add_to_roadmap", "promote_to_roadmap", "promote_feedback_to_roadmap", "update_roadmap_item", "set_launch_tier", "create_experiment", "update_experiment", "conclude_experiment", "log_experiment_result", "log_checkin"])
async function flushEvents(events: Event[]) {
  const unique = [...new Map(events.map(event => [event.action + ":" + event.source, event])).values()]
  await Promise.allSettled(unique.map(event => sendActivityEvent(event)))
}

export function collectionEpoch(): Date | null {
  const value = process.env.COMPASS_ANALYTICS_COLLECTION_STARTED_AT
  return analyticsCollectionEnabled(process.env.VERCEL_ENV, value, process.env.PREVIEW_AUTOMATION_ENABLED) ? new Date(value!) : null
}
export async function withActivityCommit<T>(handler: () => Promise<T>): Promise<T> {
  if (eventQueue.getStore()) return handler()
  const events: Event[] = []
  const result = await eventQueue.run(events, handler)
  // This scope surrounds the outer transaction, including the PM receipt.
  await flushEvents(events)
  return result
}
export const withAnalyticsTool = <T>(name: string, handler: () => Promise<T>) =>
  toolContext.run(qualifyingTools.has(name), () => withActivityCommit(handler))

async function runActivityTransaction<T>(client: AppPrismaClient, work: (tx: AppTransactionClient) => Promise<T>, options?: never): Promise<T> {
  const parent = eventQueue.getStore()
  const events: Event[] = []
  const result = await eventQueue.run(events, () => client.$transaction(work, options))
  // Only transfer events after the database accepted the commit.
  if (parent) parent.push(...events)
  else await flushEvents(events)
  return result
}

async function humanActor(): Promise<McpActor> {
  const { auth } = await import("@/auth")
  const session = await auth()
  if (!session?.user?.id) throw new Error("Not authenticated")
  return { userId: session.user.id, purpose: "USER" }
}
// Prisma's model delegates have incompatible generics. This narrow dynamic
// adapter is internal, allowlisted and never accepts caller-controlled models.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Delegate = Record<string, (args: any) => Promise<any>>
function delegate(tx: AppTransactionClient, model: string): Delegate {
  return (tx as unknown as Record<string, Delegate>)[model]
}
async function workspaceFor(tx: AppTransactionClient, model: string, row: Record<string, unknown>): Promise<string> {
  if (typeof row.workspaceId === "string") return row.workspaceId
  if (model === "solution") {
    const parent = await tx.opportunity.findUniqueOrThrow({ where: { id: String(row.opportunityId) }, select: { workspaceId: true } })
    return parent.workspaceId
  }
  if (model === "experimentResult") return (await tx.experiment.findUniqueOrThrow({ where: { id: String(row.experimentId) }, select: { workspaceId: true } })).workspaceId
  if (model === "checkIn") return (await tx.keyResult.findUniqueOrThrow({ where: { id: String(row.keyResultId) }, select: { objective: { select: { cycle: { select: { workspaceId: true } } } } } })).objective.cycle.workspaceId
  throw new Error("Activity workspace could not be resolved")
}
export async function recordActivation(tx: AppTransactionClient, workspaceId: string, layer: ActivityLayer, at: Date, epoch: Date) {
  const excluded = new Set((process.env.COMPASS_ANALYTICS_EXCLUDED_WORKSPACE_IDS ?? "").split(",").map(x => x.trim()).filter(Boolean))
  if (excluded.has(workspaceId)) return false
  // Upsert never overwrites a timestamp; a conditional update is monotonic
  // under concurrent DSQL transactions (conflicts roll the product write back).
  await tx.workspaceActivationState.upsert({ where: { workspaceId }, create: { workspaceId, collectionStartedAt: epoch }, update: {} })
  const field = `${layer}At` as "discoveryAt" | "deliveryAt" | "learningAt"
  await tx.workspaceActivationState.updateMany({ where: { workspaceId, OR: [{ [field]: null }, { [field]: { lt: at } }] }, data: { [field]: at, updatedAt: at } })
  return true
}

/** Only imported by explicit user actions and allowlisted MCP mutations. */
export function instrumentActivityClient<T extends AppTransactionClient>(client: T, source: Source, actor: () => Promise<McpActor>, inTransaction = false): T {
  const epoch = collectionEpoch()
  if (!epoch) return client
  return new Proxy(client, { get(target, key, receiver) {
    if (key === "$transaction") return async (callback: unknown, options?: unknown) => {
      if (typeof callback !== "function") throw new Error("Instrumented writes require an interactive transaction")
      return runActivityTransaction(target as unknown as AppPrismaClient, async tx => callback(instrumentActivityClient(tx, source, actor, true)), options as never)
    }
    if (typeof key !== "string" || !ACTIVITY_FIELDS[key]) return Reflect.get(target, key, receiver)
    const model = key
    return new Proxy(delegate(target, model), { get(modelTarget, operation: string) {
      const original = modelTarget[operation]
      if (!["create", "update", "updateMany"].includes(operation)) return typeof original === "function" ? original.bind(modelTarget) : original
      return async (args: { where?: Record<string, unknown>; data: Record<string, unknown>; select?: unknown; include?: unknown }) => {
        const work = async (tx: AppTransactionClient) => {
          const d = delegate(tx, model)
          const before: Record<string, unknown>[] = operation === "create" ? [] : await d.findMany({ where: args.where, take: 101 })
          if (before.length > 100) throw new Error("Activity mutation exceeds the 100-row bound")
          const identity = await actor()
          const workspaceIds = new Set<string>()
          for (const row of operation === "create" ? [args.data] : before) workspaceIds.add(await workspaceFor(tx, model, row))
          for (const workspaceId of workspaceIds) await assertWorkspaceMember(identity, workspaceId)
          const needsId = operation === "create" && args.select && !(args.select as Record<string, unknown>).id
          const result = await d[operation](needsId ? { ...args, select: { ...args.select as object, id: true } } : args)
          if (operation === "updateMany" && !result.count) return result
          // Preserve select/include return shape, while reading complete rows
          // separately for classification in the same transaction.
          const rows = operation === "create"
            ? [await d.findUniqueOrThrow({ where: { id: result.id ?? (args.data.id as string) } })]
            : await d.findMany({ where: { id: { in: before.map(row => row.id) } } })
          for (const row of rows) {
            const prior = before.find(item => item.id === row.id) ?? null
            const layer = classifyActivity(model, operation, prior, row)
            if (!layer) continue
            const workspaceId = await workspaceFor(tx, model, row)
            if (await recordActivation(tx, workspaceId, layer, new Date(), epoch)) eventQueue.getStore()?.push({ action: activityAction(model, operation, row, prior), source })
          }
          if (needsId) { const projected = { ...result }; delete projected.id; return projected }
          return result
        }
        if (inTransaction) return work(target)
        return runActivityTransaction(getPrisma(), work)
      }
    } })
  } })
}
export function getHumanActivityPrisma(): AppPrismaClient { return instrumentActivityClient(getPrisma(), "ui", humanActor) }
export function getMcpActivityPrisma(): AppPrismaClient {
  const client = getToolPrisma()
  if (!toolContext.getStore()) return client as AppPrismaClient
  const actor = getMcpActor()
  const source = actor.purpose === "AGENT" || actor.purpose === "AGENT_TURN" ? "agent" : "mcp"
  return instrumentActivityClient(client, source, async () => actor, hasToolTransaction()) as AppPrismaClient
}
