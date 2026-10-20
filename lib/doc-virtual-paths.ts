/**
 * Pure doc-tree to virtual-path projection, split out of lib/doc-fs.ts so lib/document-service.ts
 * (which doc-fs imports) can compute a doc's path inside a mutation transaction without a cycle.
 * No I/O.
 */
import { sanitizeTitleSegment } from "@/lib/doc-path"
import type { DocType } from "@/lib/doc-types"

export type DocFsNode = {
  path: string
  docId: string
  title: string
  parentId: string | null
  roadmapItemId: string | null
  docType: DocType
  hasChildren: boolean
  updatedAt: Date
}

/** First 8 hex chars of a docId, used to disambiguate a title collision among siblings. */
function collisionSuffix(docId: string): string {
  return docId.replace(/-/g, "").slice(0, 8)
}

export type DocRow = {
  id: string
  title: string
  parentId: string | null
  roadmapItemId: string | null
  docType: string
  updatedAt: Date
}

/** Builds every doc's path in one pass, deduping sibling title collisions deterministically. */
export function buildTree(docs: DocRow[]): DocFsNode[] {
  const presentIds = new Set(docs.map((d) => d.id))
  const childrenByParent = new Map<string | null, DocRow[]>()
  for (const d of docs) {
    const key = d.parentId && presentIds.has(d.parentId) ? d.parentId : null
    if (!childrenByParent.has(key)) childrenByParent.set(key, [])
    childrenByParent.get(key)!.push(d)
  }

  function segmentsFor(siblings: DocRow[]): Map<string, string> {
    const seenCount = new Map<string, number>()
    const segByDocId = new Map<string, string>()
    for (const d of siblings) {
      const base = sanitizeTitleSegment(d.title)
      const seen = seenCount.get(base) ?? 0
      seenCount.set(base, seen + 1)
      segByDocId.set(d.id, seen === 0 ? base : `${base} (${collisionSuffix(d.id)})`)
    }
    return segByDocId
  }

  const results: DocFsNode[] = []
  function walk(parentId: string | null, parentPath: string) {
    const siblings = childrenByParent.get(parentId) ?? []
    const segments = segmentsFor(siblings)
    for (const d of siblings) {
      const path = parentPath ? `${parentPath}/${segments.get(d.id)}` : segments.get(d.id)!
      results.push({
        path,
        docId: d.id,
        title: d.title,
        parentId: d.parentId,
        roadmapItemId: d.roadmapItemId,
        docType: d.docType === "GTM_POSITIONING_BRIEF" || d.docType === "CANVAS" ? d.docType : "STANDARD",
        hasChildren: (childrenByParent.get(d.id) ?? []).length > 0,
        updatedAt: d.updatedAt,
      })
      walk(d.id, path)
    }
  }
  walk(null, "")
  return results
}

/**
 * The docs the Geode sync surface exposes: STANDARD docs with no non-STANDARD (CANVAS / GTM brief)
 * ancestor. A STANDARD doc under a canvas is excluded in v1. Build the sync path tree from THIS
 * subset (`buildTree(syncScopeRows(rows))`) so collision suffixes only ever depend on in-scope siblings.
 */
export function syncScopeRows<T extends { id: string; parentId: string | null; docType: string }>(rows: T[]): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const memo = new Map<string, boolean>()
  const inScope = (row: T): boolean => {
    const known = memo.get(row.id)
    if (known !== undefined) return known
    memo.set(row.id, false) // a parent cycle resolves to out of scope instead of recursing forever
    const parent = row.parentId ? byId.get(row.parentId) : undefined
    const result = row.docType === "STANDARD" && (!parent || inScope(parent))
    memo.set(row.id, result)
    return result
  }
  return rows.filter(inScope)
}

