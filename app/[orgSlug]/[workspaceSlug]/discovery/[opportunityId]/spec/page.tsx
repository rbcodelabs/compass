import { notFound, permanentRedirect } from "next/navigation"
import getPrisma from "@/lib/db"
import { requireWorkspaceContext } from "@/lib/workspace-context"
import { resolveThinkingModel } from "@/lib/thinking-model/resolve"
import { canonicalRedirectSegment, resolveWorkItem } from "@/lib/work-item-resolve"
import { loadSpecCanvas } from "@/lib/spec-canvas/load"
import { SpecDocument } from "@/components/discovery/spec-canvas/spec-document"

type Props = {
  params: Promise<{ orgSlug: string; workspaceSlug: string; opportunityId: string }>
}

export async function generateMetadata({ params }: Props) {
  // The title is a static label: resolving the opportunity here would repeat the page's lookups.
  const { orgSlug, workspaceSlug } = await params
  const { workspace } = await requireWorkspaceContext(orgSlug, workspaceSlug)
  return { title: `${resolveThinkingModel(workspace).labels.opportunity.singular} spec` }
}

// Full-screen, editable spec for one opportunity. The segment is a UUID or a display ID (OPP-4); like the
// detail page, anything that does not resolve inside this workspace is a 404.
export default async function OpportunitySpecPage({ params }: Props) {
  const { orgSlug, workspaceSlug, opportunityId } = await params
  const { workspace, isReadOnly } = await requireWorkspaceContext(orgSlug, workspaceSlug)
  const basePath = `/${orgSlug}/${workspaceSlug}/discovery`

  const resolved = await resolveWorkItem(getPrisma(), workspace.id, "opportunity", opportunityId)
  if (!resolved.ok) notFound()
  // Converge UUID and lower-case links on the canonical display ID, keeping the /spec suffix.
  const segment = canonicalRedirectSegment(opportunityId, resolved)
  if (segment) permanentRedirect(`${basePath}/${encodeURIComponent(segment)}/spec`)

  const spec = await loadSpecCanvas({ workspaceId: workspace.id, opportunityId: resolved.id, orgSlug, workspaceSlug })
  if (!spec) notFound()

  return (
    // fixed + inset-0 lifts the canvas out of the workspace shell (sidebar/header), the same
    // full-screen treatment the artifact viewer uses; the back link is the way out.
    <div className="fixed inset-0 z-50 overflow-y-auto bg-surface-app">
      <SpecDocument
        spec={spec}
        labels={resolveThinkingModel(workspace).labels}
        backHref={`${basePath}/${encodeURIComponent(resolved.canonical)}`}
        context={{ orgSlug, workspaceSlug, workspaceId: workspace.id, opportunityId: resolved.id }}
        readOnly={isReadOnly}
      />
    </div>
  )
}
