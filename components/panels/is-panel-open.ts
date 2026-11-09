import type { PanelState, PanelType } from "./panel-context";

/**
 * True when the detail panel currently shows exactly this entity. Pure so a
 * board card can derive its "active" state from the `panel` it already reads
 * off the panel context, with no extra subscription.
 */
export function isPanelOpen(panel: PanelState | undefined, type: PanelType, id: string): boolean {
  return panel?.type === type && panel.id === id;
}
