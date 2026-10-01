/**
 * Whole surfaces converted to label-driven copy in Phase 3B. Anything not listed
 * here is NOT converted. Shared by the tripwire, the CLASSIC copy-pin test and the
 * baseline regeneration script (plain data, no imports, so Node can load it directly).
 *
 * Phase 4C-1 added the optional-cycle (#332) surfaces: lib/okr-cycle-scope.ts
 * ("No cycle / Persistent" is noCycleLabel(labels.cycle)), the persistent-objectives
 * card, "Or add an Objective with no cycle", the objective-row empty message, and
 * the Cycle field in both panels. Their CLASSIC text is pinned to what #332 shipped
 * in classic-copy-pins.test.ts ("#332 optional-cycle copy").
 */
export const CONVERTED_FILES = [
  "components/sidebar.tsx",
  "components/bottom-nav.tsx",
  "app/[orgSlug]/[workspaceSlug]/okrs/page.tsx",
  "app/[orgSlug]/[workspaceSlug]/okrs/[cycleId]/page.tsx",
  "components/okrs/add-key-result-form.tsx",
  "components/okrs/add-objective-form.tsx",
  "components/okrs/check-in-form.tsx",
  "components/okrs/create-cycle-form.tsx",
  "components/okrs/cycle-card.tsx",
  "components/okrs/key-result-bar.tsx",
  "components/okrs/objective-row.tsx",
  "components/okrs/objectives-list.tsx",
  "components/panels/objective-panel.tsx",
  "components/panels/key-result-panel.tsx",
  "components/panels/panel-shell.tsx",
  "components/panels/panel-titles.ts",
  "components/panels/roadmap-item-panel.tsx",
  "components/discovery/opportunity-composer.tsx",
  "components/discovery/opportunity-header.tsx",
  "components/discovery/opportunity-overview.tsx",
  "components/discovery/key-result-options.tsx",
  "components/tasks/task-links-panel.tsx",
  "components/tasks/link-task-dialog.tsx",
  "components/tasks/linked-type-labels.ts",
  "components/roadmap/add-item-form.tsx",
  "components/roadmap/edit-item-dialog.tsx",
  "components/discovery/discovery-rail.tsx",
  "app/[orgSlug]/[workspaceSlug]/metrics/page.tsx",
  "components/custom-fields/manage-fields-panel.tsx",
  "components/custom-fields/shared-option-sets-panel.tsx",
  "components/custom-fields/object-type-labels.ts",
  "components/analytics/metrics-dashboard.tsx",
  "app/[orgSlug]/[workspaceSlug]/settings/page.tsx",
  // Phase 3C: new surfaces, label-driven from the start (no CLASSIC baseline: they do not exist under CLASSIC).
  "app/[orgSlug]/[workspaceSlug]/discovery/tree/page.tsx",
  "components/discovery/outcome-tree-view.tsx",
  "components/okrs/outcomes-index.tsx",
  "components/discovery/opportunity-objective-picker.tsx",
  // Phase 4B: link authoring surfaces, label-driven from the start (they render nothing under CLASSIC, so there is no baseline).
  "components/discovery/solution-key-result-picker.tsx",
  "components/discovery/composer-objective-field.tsx",
  "components/discovery/linked-objectives-strip.tsx",
  "components/panels/linked-solutions-section.tsx",
  // Phase 4C-1: the optional-cycle (#332) surfaces, converted. CLASSIC text is byte-identical to what #332 shipped.
  "lib/okr-cycle-scope.ts",
  "components/okrs/persistent-objectives-card.tsx",
] as const
