import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { resolveWorkspaceAccess } from "@/lib/workspace-context"
import { getThinkingModelForSlugs } from "@/lib/thinking-model/server"
import { WorkspacePage } from "@/components/patterns/workspace-page"
import { ChainGraphWorkspace } from "@/components/chain-graph/chain-graph-workspace"
import { chainGraphEnabled, parseFocus } from "@/lib/chain-graph/flag"
import { loadChainGraph } from "@/lib/chain-graph/loader"

export const metadata = { title: "Chain graph" }

type Props = {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<{ focus?: string | string[] }>
}

/**
 * Flag-gated spike (no sidebar entry; see docs/design/chain-graph.md). Two layers, as in /api/panels/entity: a session,
 * then workspace membership resolved server-side. A non-member and a missing workspace are indistinguishable (404).
 */
export default async function ChainGraphPage({ params, searchParams }: Props) {
  if (!chainGraphEnabled()) notFound()
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) redirect("/login")

  const { orgSlug, workspaceSlug } = await params
  const access = await resolveWorkspaceAccess(orgSlug, workspaceSlug, userId)
  if (!access) notFound()

  const thinkingModel = await getThinkingModelForSlugs(orgSlug, workspaceSlug)
  const graph = await loadChainGraph(getPrisma(), access.workspaceId, { links: thinkingModel.links })
  const focus = parseFocus((await searchParams).focus)
  const initialFocus = focus && graph.nodes.some((n) => n.key === focus) ? focus : null

  return (
    <WorkspacePage title="Chain graph" description={`${thinkingModel.labels.objective.plural} through roadmap items. Select an object to trace its chain.`}>
      <ChainGraphWorkspace graph={graph} initialFocus={initialFocus} />
    </WorkspacePage>
  )
}
