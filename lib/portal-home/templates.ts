import { z } from "zod"

/**
 * Portal Home templates. Client-safe constants only (no server imports) so the admin template picker, the
 * API routes and the customer page share one list. A template changes how the same widgets are laid out,
 * never which data a customer may see: visibility and resolution are template-independent.
 */
export const PORTAL_TEMPLATES = ["editorial", "bento", "shell", "docs_hub"] as const
export type PortalTemplate = (typeof PORTAL_TEMPLATES)[number]

export const DEFAULT_PORTAL_TEMPLATE: PortalTemplate = "editorial"

export const portalTemplateSchema = z.enum(PORTAL_TEMPLATES)

export const PORTAL_TEMPLATE_META: Record<PortalTemplate, { label: string; description: string }> = {
  editorial: { label: "Editorial", description: "A single, readable column that leads with your announcement." },
  bento: { label: "Bento", description: "A grid of tiles sized by widget, for a dashboard feel." },
  shell: { label: "Shell", description: "A sidebar for navigation with your widgets in the main area." },
  docs_hub: { label: "Docs hub", description: "Search-first home that puts your published docs front and center." },
}

export function isPortalTemplate(value: unknown): value is PortalTemplate {
  return portalTemplateSchema.safeParse(value).success
}

/** Lenient read of a stored value: NULL (pre-migration rows) and unknown values fall back to editorial. */
export function coerceStoredTemplate(value: unknown): PortalTemplate {
  return isPortalTemplate(value) ? value : DEFAULT_PORTAL_TEMPLATE
}
