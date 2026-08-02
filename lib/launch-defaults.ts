/**
 * Sensible default checklist templates, one per launch tier. Used by
 * `resolveOrSeedTemplate` (lib/launch-checklist.ts) to auto-seed a workspace's
 * first template for a tier the first time someone sets that tier from the
 * web UI — so the tier picker "just works" without an agent having to run
 * create_checklist_template first. Seeded templates are ordinary ACTIVE
 * ChecklistTemplate rows and are fully editable afterward.
 */
import type { LaunchTier } from "@/lib/types";

export interface DefaultChecklistItem {
  label: string;
  description?: string;
}

export interface DefaultChecklistTemplate {
  name: string;
  description: string;
  items: DefaultChecklistItem[];
}

export const DEFAULT_CHECKLIST_TEMPLATES: Record<LaunchTier, DefaultChecklistTemplate> = {
  TIER_1: {
    name: "Major Launch",
    description: "Full go-to-market push for a flagship release.",
    items: [
      { label: "Publish launch announcement / blog post" },
      { label: "Brief support & customer success teams" },
      { label: "Update marketing site and pricing page" },
      { label: "Coordinate press and social rollout" },
      { label: "Prepare in-app announcement" },
      { label: "Confirm analytics & success metrics are instrumented" },
    ],
  },
  TIER_2: {
    name: "Minor Launch",
    description: "Lightweight rollout for an incremental improvement.",
    items: [
      { label: "Write changelog entry" },
      { label: "Notify affected customers" },
      { label: "Update product documentation" },
      { label: "Brief the support team" },
    ],
  },
  TIER_3: {
    name: "Silent Launch",
    description: "Ship quietly — no external announcement.",
    items: [
      { label: "Update the changelog" },
      { label: "Verify the feature flag / rollout is healthy" },
    ],
  },
};
