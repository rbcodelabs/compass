import type { DocKind } from "@/lib/doc-kinds"

/**
 * Kinds an agent's local file may claim through a plain `kind:` frontmatter key. Deliberately a short whitelist: the key is
 * author-controlled text, so it may only select a harmless, content-only kind. Keyed by the normalized spelling (see
 * normalizeKindClaim). docType values (CANVAS, SPEC, GTM_POSITIONING_BRIEF) are never reachable from here.
 *
 * Lives beside lib/doc-kinds.ts rather than in it because doc-kinds.ts is digest-pinned by the managed-migration manifest.
 */
const FRONTMATTER_KIND_WHITELIST: Readonly<Record<string, DocKind>> = {
  "qa report": "QA_REPORT",
}

/** Trim, lowercase, and treat runs of `-`, `_` and whitespace as one space: "QA-Report", " qa_report " and "qa report" are the same claim. */
function normalizeKindClaim(value: string): string {
  return value.trim().toLowerCase().replace(/[-_\s]+/g, " ")
}

/**
 * The DocKind a frontmatter `kind:` value may set on CREATE, or null when the value is not whitelisted (including any non-string,
 * array, empty string or a docType name). Callers apply it to newly created docs only, never to an existing doc.
 */
export function kindFromFrontmatterClaim(value: unknown): DocKind | null {
  if (typeof value !== "string") return null
  const claim = normalizeKindClaim(value)
  return Object.hasOwn(FRONTMATTER_KIND_WHITELIST, claim) ? FRONTMATTER_KIND_WHITELIST[claim] : null
}
