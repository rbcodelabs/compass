import { DOC_KINDS, DOC_KIND_LABELS, NO_KIND_LABEL, normalizeDocKind, type DocKind } from "@/lib/doc-kinds"

/**
 * Pure grouping and ordering for the Docs Library views (`/docs`): overview counts, By type, Recent. No data fetching here: the page loads
 * the workspace's docs and hands them in, so these stay unit-testable.
 */
export type LibraryDoc = { id: string; title: string; kind: string | null; updatedAt: Date; docType?: string | null }

export const LIBRARY_VIEWS = ["overview", "by-type", "recent"] as const
export type LibraryView = (typeof LIBRARY_VIEWS)[number]

/** How many docs the overview lists as the latest, and how many the Recent view lists. */
export const LIBRARY_LATEST_LIMIT = 8
export const LIBRARY_RECENT_LIMIT = 50

/** `?view=`: overview is the default, so any other value (or none, or a repeated param) is the overview. */
export function parseLibraryView(raw: string | string[] | undefined): LibraryView {
  return typeof raw === "string" && (LIBRARY_VIEWS as readonly string[]).includes(raw) ? (raw as LibraryView) : "overview"
}

export type KindCounts = { total: number; byKind: { kind: DocKind; label: string; count: number }[]; noType: number }

/** Docs per kind, in the fixed kind order, plus how many have no (or an unrecognised) kind. Every kind is listed, at zero if need be. */
export function kindCounts(docs: readonly LibraryDoc[]): KindCounts {
  const counts = new Map<DocKind, number>()
  let noType = 0
  for (const doc of docs) {
    const kind = normalizeDocKind(doc.kind)
    if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1)
    else noType += 1
  }
  return {
    total: docs.length,
    byKind: DOC_KINDS.map((kind) => ({ kind, label: DOC_KIND_LABELS[kind], count: counts.get(kind) ?? 0 })),
    noType,
  }
}

const byRecency = (a: LibraryDoc, b: LibraryDoc) =>
  b.updatedAt.getTime() - a.updatedAt.getTime() || a.title.localeCompare(b.title) || a.id.localeCompare(b.id)

export type KindGroup = { kind: DocKind | null; label: string; docs: LibraryDoc[] }

/** Docs grouped by kind in the fixed kind order, "No type" last, empty groups omitted. Each group is most recently updated first. */
export function groupDocsByKind(docs: readonly LibraryDoc[]): KindGroup[] {
  const grouped = new Map<DocKind | null, LibraryDoc[]>()
  for (const doc of docs) {
    const kind = normalizeDocKind(doc.kind)
    grouped.set(kind, [...(grouped.get(kind) ?? []), doc])
  }
  const order: (DocKind | null)[] = [...DOC_KINDS, null]
  return order
    .filter((kind) => (grouped.get(kind)?.length ?? 0) > 0)
    .map((kind) => ({ kind, label: kind ? DOC_KIND_LABELS[kind] : NO_KIND_LABEL, docs: [...grouped.get(kind)!].sort(byRecency) }))
}

/** The most recently updated docs, newest first. */
export function recentDocs(docs: readonly LibraryDoc[], limit: number = LIBRARY_RECENT_LIMIT): LibraryDoc[] {
  return [...docs].sort(byRecency).slice(0, Math.max(0, limit))
}
