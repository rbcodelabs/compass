/**
 * Doc.kind values: what a doc IS in the Library (a decision record, a QA report, a design, a note). The column is a free-form
 * nullable VarChar(30) (migration 117, no DB enum, no index), so adding a kind later needs no migration; this list is the single
 * source for validation. NULL means "no type", which is every existing doc until someone (or the 118 backfill) sets one.
 *
 * `kind` is independent of `docType` (lib/doc-types.ts): docType says how a doc is stored and edited (markdown, canvas, spec), kind
 * says what it is for. Spec and Discovery Plan docs keep their own docType; there is deliberately no kind for them.
 */
export const DOC_KINDS = ["ADR", "QA_REPORT", "DESIGN", "NOTE"] as const
export type DocKind = (typeof DOC_KINDS)[number]

/** Generic user-facing labels. */
export const DOC_KIND_LABELS: Record<DocKind, string> = {
  ADR: "ADR",
  QA_REPORT: "QA report",
  DESIGN: "Design",
  NOTE: "Note",
}

/** What the UI calls a doc with no kind. */
export const NO_KIND_LABEL = "No type"

export function isDocKind(value: unknown): value is DocKind {
  return typeof value === "string" && (DOC_KINDS as readonly string[]).includes(value)
}

/** A stored or supplied kind as a known DocKind. The column is free-form, so anything unrecognised reads as unset (null). */
export function normalizeDocKind(value: unknown): DocKind | null {
  return isDocKind(value) ? value : null
}

/** The label for a stored kind; an unset or unrecognised kind reads as "No type". */
export function docKindLabel(kind: string | null | undefined): string {
  const known = normalizeDocKind(kind)
  return known ? DOC_KIND_LABELS[known] : NO_KIND_LABEL
}

/**
 * Kinds an agent's local file may claim through a plain `kind:` frontmatter key. Deliberately a short whitelist: the key is
 * author-controlled text, so it may only select a harmless, content-only kind. Keyed by the normalized spelling (see
 * normalizeKindClaim). docType values (CANVAS, SPEC, GTM_POSITIONING_BRIEF) are never reachable from here.
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
  return FRONTMATTER_KIND_WHITELIST[normalizeKindClaim(value)] ?? null
}
