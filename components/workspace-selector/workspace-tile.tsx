import Link from "next/link"
import { Clock, Eye, Users } from "lucide-react"

import {
  describeWorkspace,
  pluralize,
  visitedLabel,
  workspaceHref,
  type SelectorWorkspace,
} from "./model"
import { WorkspaceAvatar, WorkspaceCover } from "./workspace-cover"

/**
 * Gallery card for one workspace. A real link (not a button) so middle-click,
 * prefetch and "open in new tab" work. `data-wsx-item` is the hook the
 * gallery's roving keyboard navigation queries for.
 */
export function WorkspaceTile({
  workspace,
  isCurrent = false,
  large = false,
  visitedAt,
}: {
  workspace: SelectorWorkspace
  isCurrent?: boolean
  large?: boolean
  visitedAt?: number
}) {
  const { name, description, memberCount, isReadOnly = false } = workspace
  const hasDescription = Boolean(description && description.trim())

  return (
    <Link
      href={workspaceHref(workspace)}
      className="wsx-tile"
      data-wsx-item=""
      aria-label={describeWorkspace(workspace, isCurrent)}
      aria-current={isCurrent ? "true" : undefined}
      title={name.length > 30 ? name : undefined}
    >
      <WorkspaceCover name={name} readOnly={isReadOnly}>
        <WorkspaceAvatar name={name} size={large ? "xl" : "lg"} readOnly={isReadOnly} />
        {isCurrent ? (
          <span className="wsx-pill wsx-pill-here">{large ? "You are here" : "Current"}</span>
        ) : isReadOnly ? (
          <span className="wsx-pill">
            <Eye className="wsx-icon" aria-hidden="true" />
            Read-only
          </span>
        ) : null}
      </WorkspaceCover>

      <span className="wsx-tile-body">
        <span className="wsx-tile-name">{name}</span>
        <span className="wsx-tile-desc" data-empty={!hasDescription}>
          {hasDescription ? description : "No description yet"}
        </span>
      </span>

      <span className="wsx-tile-meta">
        {typeof memberCount === "number" && (
          <span>
            <Users className="wsx-icon" aria-hidden="true" />
            {pluralize(memberCount, "member")}
          </span>
        )}
        <span>
          <Clock className="wsx-icon" aria-hidden="true" />
          {visitedLabel(visitedAt)}
        </span>
      </span>
    </Link>
  )
}

/** Loading placeholder matching the tile's footprint so the page does not jump. */
export function WorkspaceTileSkeleton() {
  return (
    <div className="wsx-tile wsx-tile-skel" aria-hidden="true">
      <span className="wsx-cover wsx-skel" />
      <span className="wsx-tile-body">
        <i className="wsx-line wsx-skel w70" />
        <i className="wsx-line wsx-skel" />
        <i className="wsx-line wsx-skel w45" />
      </span>
      <span className="wsx-tile-meta">
        <i className="wsx-line wsx-skel w30" />
      </span>
    </div>
  )
}
