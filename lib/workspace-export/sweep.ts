import { MODEL_BUCKETS } from "@/lib/workspace-export/model-registry"
import { StuckDeleteError, deleteIdsLeafFirst, isRestrictViolation, withRetry } from "@/lib/workspace-export/leaf-first"
import { PARENT, delegateFor, exportOrder, modelHasId, modelHasWorkspaceId } from "@/lib/workspace-export/scope"

type Client = unknown
type Row = Record<string, unknown>
const PAGE = 500

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/**
 * Final backstop for workspace deletion: removes every row of every exported (content) model that still belongs to the
 * workspace, children before parents, tolerating Prisma's emulated Restrict by retrying until nothing more can be removed.
 *
 * The hand-written steps in deleteWorkspaceCascade come first because they also reclaim blobs and links. This sweep exists so a
 * model added to the registry (or missed by those steps) can never block `workspace.delete`: model-registry.ts classifies every
 * Prisma model, a test fails for an unclassified one, and the sweep is driven by the same registry and scope map the export uses.
 *
 * `only` limits the sweep to some models. Callers use it to clear families that reference many others (comments, card sorts)
 * early, so they cannot block the steps that delete what they point at. A child model's parent must be in the same list (or have
 * been swept already), since children are found through their parents' ids.
 *
 * Workspace-owned Agents are left to deleteWorkspaceAgentData (they have runs, sessions and grants of their own).
 * Safe to run repeatedly. Returns how many rows it removed per model.
 */
export async function sweepWorkspaceOwnedRows(
  client: Client,
  workspaceId: string,
  options: { only?: readonly string[] } = {},
): Promise<Record<string, number>> {
  const models = exportOrder().filter((m) => m !== "Agent" && MODEL_BUCKETS[m] === "CONTENT" && (!options.only || options.only.includes(m)))
  for (const m of options.only ?? []) if (!models.includes(m)) throw new Error(`sweepWorkspaceOwnedRows: ${m} is not a sweepable content model`)

  // Collect ids parents-first (children are selected through their parents' ids), then delete in the reverse order.
  const idsByModel = new Map<string, string[]>()
  const selectors = new Map<string, Row[]>()
  for (const model of models) {
    const delegate = delegateFor(client, model)
    const wheres: Row[] = []
    if (modelHasWorkspaceId(model)) wheres.push({ workspaceId })
    else {
      const parent = PARENT[model]
      if (!parent) continue
      for (const group of chunks(idsByModel.get(parent.model) ?? [], 200)) wheres.push({ [parent.fk]: { in: group } })
    }
    selectors.set(model, wheres)
    if (!modelHasId(model)) continue
    const ids: string[] = []
    for (const where of wheres) {
      let cursor: string | undefined
      for (;;) {
        const rows = (await delegate.findMany({ where, select: { id: true }, orderBy: { id: "asc" }, take: PAGE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) })) as { id: string }[]
        ids.push(...rows.map((r) => r.id))
        if (rows.length < PAGE) break
        cursor = rows[rows.length - 1].id
      }
    }
    idsByModel.set(model, ids)
  }

  const removed: Record<string, number> = {}
  let pending = [...models].reverse().filter((m) => selectors.has(m))
  let lastError: unknown
  while (pending.length) {
    const next: string[] = []
    for (const model of pending) {
      const delegate = delegateFor(client, model)
      try {
        if (modelHasId(model)) {
          const ids = idsByModel.get(model) ?? []
          for (const group of chunks(ids, PAGE)) await deleteIdsLeafFirst(delegate, group)
          removed[model] = (removed[model] ?? 0) + ids.length
          idsByModel.set(model, [])
        } else {
          // Keyed by workspace or by parent (counter rows, 1:1 children): delete by the same selector.
          for (const where of selectors.get(model) ?? []) {
            const { count } = await withRetry(() => delegate.deleteMany({ where }))
            removed[model] = (removed[model] ?? 0) + count
          }
        }
      } catch (error) {
        if (!isRestrictViolation(error) && !(error instanceof StuckDeleteError)) throw error
        lastError = error
        next.push(model)
      }
    }
    if (next.length === pending.length) {
      throw new StuckDeleteError(`Workspace cleanup is blocked on ${next.join(", ")}: ${(lastError as Error)?.message?.split("\n").slice(-2).join(" ").trim()}`)
    }
    pending = next
  }
  return removed
}
