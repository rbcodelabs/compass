import { Eye } from "lucide-react"

/**
 * Shown at the top of workspace content when the caller has no
 * WorkspaceMember row and is only here via
 * Organization.memberWorkspaceReadOnlyAccess (see lib/workspace-context.ts /
 * lib/workspace.ts). Deliberately a single light-touch banner rather than a
 * per-page treatment -- the write paths are the actual enforcement boundary
 * (assertWorkspaceWritable), this is purely informational so the read-only
 * user understands why controls are missing or disabled.
 */
export function ReadOnlyBanner() {
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-border-default bg-surface-subtle px-4 py-2 text-xs text-text-secondary sm:px-6 md:px-8"
    >
      <Eye className="size-3.5 shrink-0 text-text-subtle" aria-hidden="true" />
      <span>
        You have read-only access to this workspace via your organization. Settings, members, and
        editing are unavailable.
      </span>
    </div>
  )
}
