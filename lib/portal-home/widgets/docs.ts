import { z } from "zod"
import { requiredText, uuidLike } from "../fields"

export const DOCS_WIDGET_MODES = ["all", "selected"] as const
export const DOCS_WIDGET_MAX_ITEMS = 12

/**
 * Published Docs. "all" lists the newest published docs; "selected" shows only the chosen ids, in the
 * admin's order, and silently drops any that are not (or are no longer) published. Selecting a doc never
 * publishes it: the resolver returns published docs only (lib/portal-docs).
 */
export const docsConfig = z.object({
  heading: requiredText(80),
  maxItems: z.number().int().min(1).max(DOCS_WIDGET_MAX_ITEMS).default(6),
  mode: z.enum(DOCS_WIDGET_MODES).default("all"),
  docIds: z.array(uuidLike).max(DOCS_WIDGET_MAX_ITEMS).default([]),
})
export type DocsConfig = z.infer<typeof docsConfig>

export const docsDefinition = {
  type: "docs" as const,
  label: "Docs",
  description: "Docs you have published to the portal",
  defaultSize: "M" as const,
  configSchema: docsConfig,
  defaultConfig: (): DocsConfig => ({ heading: "Docs", maxItems: 6, mode: "all", docIds: [] }),
}
