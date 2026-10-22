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
