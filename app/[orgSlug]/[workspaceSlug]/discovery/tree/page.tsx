import { notFound } from "next/navigation"
import getPrisma from "@/lib/db"
import { requireWorkspaceContext } from "@/lib/workspace-context"
import { resolveThinkingModel } from "@/lib/thinking-model/resolve"
import { getThinkingModelForSlugs } from "@/lib/thinking-model/server"
import { loadOutcomeTree } from "@/lib/thinking-model/outcome-tree-data"
import { OutcomeTreeView } from "@/components/discovery/outcome-tree-view"
import { PageHeader } from "@/components/patterns"
import type { OutcomeTreeShape } from "@/lib/thinking-model/outcome-tree"

type Props = {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}

export async function generateMetadata({ params }: Props) {
  const { orgSlug, workspaceSlug } = await params
  const { labels } = await getThinkingModelForSlugs(orgSlug, workspaceSlug)
  return { title: `${labels.objective.singular} tree` }
}

/**
 * Workspace-level tree for TORRES_OST and OPPORTUNITY_FIRST_OKR. CLASSIC (and any
 * workspace that never chose a model) has no such view: the route is a 404 there, so
 * a CLASSIC workspace sees exactly what it saw before. The existing per-opportunity
 * tree tab and the canvas are untouched.
 */
export default async function OutcomeTreePage({ params }: Props) {
  const { orgSlug, workspaceSlug } = await params
  // Redirects the signed-out; a non-member and a missing workspace are both a 404.
  const { workspace } = await requireWorkspaceContext(orgSlug, workspaceSlug)
  const model = resolveThinkingModel(workspace)
  if (model.tree === "kr-rooted") notFound()
  const shape: OutcomeTreeShape = model.tree

  const tree = await loadOutcomeTree(getPrisma(), workspace.id, shape)

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6 p-4 sm:p-6 md:p-8">
      <PageHeader
        title={`${model.labels.objective.singular} tree`}
        description={
          shape === "outcome-rooted"
            ? `Each ${model.labels.objective.lower} with the ${model.labels.opportunity.lowerPlural} we chose to pursue and the ${model.labels.solution.lowerPlural} we are trying.`
            : `The ${model.labels.opportunity.lower} pool, then each ${model.labels.objective.lower} with its ${model.labels.keyResult.lowerPlural} and the ${model.labels.solution.lowerPlural} aimed at them.`
        }
      />
      <OutcomeTreeView tree={tree} />
    </main>
  )
}
