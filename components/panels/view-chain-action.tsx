import { Network } from "lucide-react"
import Link from "next/link"
import { buttonVariants } from "@/components/ui/button"
import { chainFocusParam } from "@/lib/chain-graph/focus"

/**
 * "View chain" in the detail panel header: links to /graph?focus=<TYPE>:<id> for entities in the v1 core chain. Renders
 * nothing when the graph is off for this deployment (the page itself is flag-gated) or the type has no node (key results,
 * tasks, feedback). `id` may be a UUID or a display ID; the graph page resolves either inside the workspace.
 */
export function ViewChainAction({ enabled, orgSlug, workspaceSlug, type, id }: { enabled: boolean; orgSlug: string; workspaceSlug: string; type: string; id: string }) {
  const focus = enabled ? chainFocusParam(type, id) : null
  if (!focus) return null
  return (
    <Link
      className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
      href={`/${orgSlug}/${workspaceSlug}/graph?focus=${encodeURIComponent(focus)}`}
      aria-label="View chain"
      title="View chain"
      data-slot="panel-view-chain"
    >
      <Network aria-hidden />
    </Link>
  )
}
