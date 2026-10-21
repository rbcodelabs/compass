/**
 * The only file in lib/chain-graph that touches the database, and it does so only through getCanvasOverview: every query
 * there is workspace-scoped (where: { workspaceId }, or the Objective/Solution relation filter for Key Results and
 * Assumptions) and link rows are read through the per-family read-flag seam, so this loader is correct before and after
 * the entity_links read flip with no change. Callers must have resolved workspace access first (page: session +
 * resolveWorkspaceAccess); `workspaceId` must never come from the client.
 */
import type { AppPrismaClient } from "@/lib/db"
import { getCanvasOverview } from "@/lib/canvas/data"
import type { CanvasEdgeOptions } from "@/lib/canvas/edges"
import { buildChainGraph, type BuildChainGraphOptions } from "./build"
import { DEFAULT_FOCUS_DEPTH, focusSubgraph } from "./focus"
import type { ChainGraph } from "./types"

export type LoadChainGraphOptions = Pick<BuildChainGraphOptions, "globalCap" | "perTypeCap"> & {
  /** The workspace thinking model's link emphasis (resolveThinkingModel(...).links). */
  links?: NonNullable<CanvasEdgeOptions["links"]>
}

export async function loadChainGraph(prisma: AppPrismaClient, workspaceId: string, options: LoadChainGraphOptions = {}): Promise<ChainGraph> {
  const links = options.links
  const overview = await getCanvasOverview(prisma, workspaceId, { linkOrigins: links?.oppToObjective === "hidden" ? "DIRECT" : "ALL" })
  return buildChainGraph(overview, { edgeOptions: links ? { links } : undefined, globalCap: options.globalCap, perTypeCap: options.perTypeCap })
}

const UNCAPPED = 20_000

export type ChainGraphRequest = LoadChainGraphOptions & {
  /** An already-resolved, workspace-scoped node key. Callers resolve it with resolveFocusKey; never pass client text here. */
  focusKey?: string | null
  depth?: number
}

/**
 * The graph for a request. Workspace scope is the capped structural graph. With a focus, the chain around it is returned
 * from an uncapped load so a deep link is complete even when the workspace view was truncated; a focus that is not in the
 * workspace graph (unknown or foreign) yields null focus handling at the caller, never another workspace's data.
 */
export async function loadChainGraphForRequest(prisma: AppPrismaClient, workspaceId: string, request: ChainGraphRequest = {}): Promise<ChainGraph> {
  const { focusKey, depth, ...options } = request
  if (!focusKey) return loadChainGraph(prisma, workspaceId, options)
  const full = await loadChainGraph(prisma, workspaceId, { ...options, globalCap: UNCAPPED, perTypeCap: UNCAPPED })
  return focusSubgraph(full, focusKey, depth ?? DEFAULT_FOCUS_DEPTH) ?? { nodes: [], edges: [], truncated: null }
}
