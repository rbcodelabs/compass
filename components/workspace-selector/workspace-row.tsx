import Link from "next/link"
import { Check } from "lucide-react"

import { describeWorkspace, type SelectorWorkspace } from "./model"
import { WorkspaceAvatar } from "./workspace-cover"

/** Compact 38px row for the sidebar picker. `href` lets the caller preserve the current section when switching. */
export function WorkspaceRow({
  workspace,
  href,
  isCurrent = false,
  onNavigate,
}: {
  workspace: SelectorWorkspace
  href: string
  isCurrent?: boolean
  onNavigate?: () => void
}) {
  const { name, isReadOnly = false } = workspace
  return (
    <Link
      href={href}
      className="wsx-row"
      data-wsx-item=""
      aria-label={describeWorkspace(workspace, isCurrent)}
      aria-current={isCurrent ? "true" : undefined}
      title={name.length > 30 ? name : undefined}
      onClick={onNavigate}
    >
      <WorkspaceAvatar name={name} size="sm" readOnly={isReadOnly} />
      <span className="wsx-row-name">{name}</span>
      {isReadOnly && <span className="wsx-badge">Read-only</span>}
      {isCurrent && <Check className="wsx-icon wsx-row-check" aria-hidden="true" />}
    </Link>
  )
}
