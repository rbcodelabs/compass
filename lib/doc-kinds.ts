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
