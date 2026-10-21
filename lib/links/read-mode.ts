/**
 * The per-family read-mode flags of the entity_links read flip. Kept import-free (no registry, no typed-links) so the legacy reader
 * modules can consult a flag without a static import cycle; lib/links/registry.ts re-exports everything here.
 */

/** The read-flip units. Each has its own flag, so one family can shadow or flip without touching the others. */
export const LINK_READ_FAMILIES = ["SOLUTION_KR", "OPPORTUNITY", "ARTIFACT", "TASK"] as const
export type LinkReadFamily = (typeof LINK_READ_FAMILIES)[number]
export type LinkReadMode = "off" | "shadow" | "on"

/** The env flag of each family. Values: off | shadow | on. Anything else is off. */
export const LINK_READ_FLAG_NAMES: Readonly<Record<LinkReadFamily, string>> = Object.freeze({
  SOLUTION_KR: "COMPASS_ENTITY_LINKS_SOLUTION_KR_READ",
  OPPORTUNITY: "COMPASS_ENTITY_LINKS_OPPORTUNITY_READ",
  ARTIFACT: "COMPASS_ENTITY_LINKS_ARTIFACT_READ",
  TASK: "COMPASS_ENTITY_LINKS_TASK_READ",
})

/**
 * The read mode of one family. Fail-closed everywhere: only the exact strings "shadow" and "on" enable anything, and outside production
 * the default is off too (unlike the *_MIRROR flags, which default on outside production), so no read path changes unless a flag is set.
 * Matching is exact in every environment (no trimming, no case folding), so a flag cannot mean one thing in preview and another in production.
 */
export function getLinkReadMode(family: LinkReadFamily): LinkReadMode {
  const value = process.env[LINK_READ_FLAG_NAMES[family]]
  return value === "shadow" || value === "on" ? value : "off"
}
