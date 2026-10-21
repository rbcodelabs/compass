"use client"

import { createContext } from "react"

/**
 * View state the node renderers read. Carried by context (not node `data`) so a selection change re-renders memoised
 * nodes without rebuilding the nodes array, which React Flow would treat as a new graph and re-measure.
 */
export type ChainGraphUi = {
  selectedRep: string | null
  /** Visible keys on the traced chain; null when nothing is selected. */
  traced: ReadonlySet<string> | null
  hideUnrelated: boolean
  /** Visible keys matching the search box; null when the box is empty. */
  matches: ReadonlySet<string> | null
  pinned: ReadonlySet<string>
  onSelect: (key: string) => void
  onToggleGroup: (groupId: string) => void
}

export const ChainGraphUiContext = createContext<ChainGraphUi>({
  selectedRep: null,
  traced: null,
  hideUnrelated: false,
  matches: null,
  pinned: new Set(),
  onSelect: () => {},
  onToggleGroup: () => {},
})
