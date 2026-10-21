import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { resolveWorkspaceAccess } from "@/lib/workspace-context"
import { getThinkingModelForSlugs } from "@/lib/thinking-model/server"
import { WorkspacePage } from "@/components/patterns/workspace-page"
import { ChainGraphWorkspace } from "@/components/chain-graph/chain-graph-workspace"
import { chainGraphEnabled } from "@/lib/chain-graph/flag"
import { parseFocusRef, resolveFocusKey } from "@/lib/chain-graph/focus"
import { loadChainGraph, loadChainGraphForRequest } from "@/lib/chain-graph/loader"

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
  const prisma = getPrisma()
  const links = thinkingModel.links
  // ?focus= takes a UUID or a display ID; it resolves only inside this workspace, and anything else is ignored.
  const parsed = parseFocusRef((await searchParams).focus)
  const focusKey = parsed ? await resolveFocusKey(prisma, access.workspaceId, parsed) : null
  let graph = await loadChainGraph(prisma, access.workspaceId, { links })
  // A truncated workspace view can leave a focused chain incomplete (edges to cut nodes are dropped), so load the chain itself.
  if (focusKey && (graph.truncated || !graph.nodes.some((n) => n.key === focusKey))) {
    graph = await loadChainGraphForRequest(prisma, access.workspaceId, { links, focusKey })
  }
  const initialFocus = focusKey && graph.nodes.some((n) => n.key === focusKey) ? focusKey : null

  return (
    <WorkspacePage title="Chain graph" description={`${thinkingModel.labels.objective.plural} through roadmap items. Select an object to trace its chain.`}>
      <ChainGraphWorkspace graph={graph} initialFocus={initialFocus} />
    </WorkspacePage>
  )
}
