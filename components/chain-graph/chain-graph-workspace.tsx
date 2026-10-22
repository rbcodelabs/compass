"use client"

import { usePanelContext } from "@/components/panels/panel-context"
import { toPanelEntityType } from "@/lib/entity-types"
import type { ChainGraph, ChainNodeType } from "@/lib/chain-graph/types"
import { ChainGraphView } from "./chain-graph-view"

/** Wires the graph's "Open" buttons to the shared detail panel (the provider is mounted in the workspace layout). */
export function ChainGraphWorkspace({ graph, initialFocus }: { graph: ChainGraph; initialFocus: string | null }) {
  const { openPanel } = usePanelContext()
  const onOpenDetails = (type: ChainNodeType, id: string) => {
    const panelType = toPanelEntityType(type)
    if (panelType) openPanel(panelType, id)
  }
  return <ChainGraphView graph={graph} initialFocus={initialFocus} onOpenDetails={onOpenDetails} />
}
