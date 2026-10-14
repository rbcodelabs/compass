"use client"

import { WorkspaceCreateButton } from "@/components/patterns/workspace-header-controls"
import { usePanelContext } from "@/components/panels/panel-context"
import { experimentComposerId } from "@/lib/experiment-draft"

/**
 * Opens the "New experiment" composer in the right-hand panel slot. On wide
 * viewports it docks beside the board (see PanelShell), so the board stays
 * usable while writing.
 */
export function NewExperimentButton() {
  const { panel, openPanel } = usePanelContext()
  const id = experimentComposerId()
  const composerOpen = panel?.type === "experiment-new"

  const open = () => {
    // Already showing exactly this: leave the draft and the history alone.
    if (composerOpen && panel.id === id) return
    openPanel("experiment-new", id, { replace: composerOpen })
  }

  return (
    <WorkspaceCreateButton label="New Experiment" onClick={open} aria-expanded={composerOpen} />
  )
}
