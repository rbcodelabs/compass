"use client"

import { useEffect } from "react"

import { workspaceKey } from "./model"
import { recordWorkspaceVisit } from "./visits"

/**
 * Renders nothing. Stamps the current workspace as "just visited" so the
 * gallery's "Jump back in" row and the picker's "Recent" group have data.
 * Mounted in the workspace layout, which persists across in-workspace
 * navigation, so this fires once per workspace entry rather than per page.
 */
export function WorkspaceVisitRecorder({ orgSlug, workspaceSlug, userScope }: { orgSlug: string; workspaceSlug: string; userScope?: string }) {
  useEffect(() => {
    recordWorkspaceVisit(workspaceKey({ orgSlug, slug: workspaceSlug }), Date.now(), userScope)
  }, [orgSlug, workspaceSlug, userScope])
  return null
}
