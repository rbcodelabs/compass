/**
 * The "New …" composer panels that share the detail-panel slot. Kept apart
 * from panel-context so layout code (PanelShell) can branch on them without
 * depending on the provider module, which many tests replace with a mock.
 */
export const COMPOSER_PANEL_TYPES = ["feedback-new", "opportunity-new"] as const;

export type ComposerPanelType = (typeof COMPOSER_PANEL_TYPES)[number];

export function isComposerPanelType(type: string | null | undefined): type is ComposerPanelType {
  return (COMPOSER_PANEL_TYPES as readonly string[]).includes(type ?? "");
}
