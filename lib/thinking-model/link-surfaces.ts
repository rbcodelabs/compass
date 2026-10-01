/**
 * Server helpers for the Solution <-> Key Result link surfaces (Phase 4B): the picker on the Solution panel and the
 * "Linked solutions" list on the Key Result panel.
 *
 * A preset only decides whether these surfaces are OFFERED (links.solToKr is not "hidden"); the data and the
 * authorization are identical across presets. So the queries below are skipped for a preset that hides the surface
 * (CLASSIC reads nothing extra), and never change what a write may do.
 */
import type { AppPrismaClient } from "@/lib/db"
import { isMissingLinkTable, listLinks } from "@/lib/typed-links"
import { resolveThinkingModel, type ThinkingModelSource } from "./resolve"

/** Whether the workspace's preset offers the Solution <-> Key Result surfaces. */
export function offersSolutionToKrSurfaces(source: ThinkingModelSource | null | undefined): boolean {
  return resolveThinkingModel(source ?? {}).links.solToKr !== "hidden"
}

/** The thinking-model columns of one workspace, for a detail fetcher that does not already load them. */
export async function loadThinkingModelSource(prisma: AppPrismaClient, workspaceId: string): Promise<ThinkingModelSource> {
  const row = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { thinkingModel: true, thinkingModelLabels: true } })
  return row ?? {}
}

/**
 * The tolerant link reads return an empty list when the table is missing, which would read as "no links". When a list came
 * back empty, ask the fail-closed `listLinks` about the entity: ONLY a missing-table error means "unavailable" (any other
 * failure would have surfaced from the main reads). Costs nothing when links exist.
 */
export async function probeSolToKrUnavailable(
  prisma: AppPrismaClient,
  workspaceId: string,
  entity: { solutionId: string } | { keyResultId: string },
): Promise<boolean> {
  try {
    await listLinks(prisma, { workspaceId, ...entity, limit: 1 })
    return false
  } catch (error) {
    return isMissingLinkTable(error)
  }
}
