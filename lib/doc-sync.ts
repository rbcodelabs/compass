/**
 * Geode doc sync: per-workspace change log (ADR "Compass as a Geode Sync Provider", spike).
 *
 * `recordDocChange` is called from lib/document-service.ts INSIDE the same transaction as every
 * STANDARD-doc mutation, so a change row exists if and only if the mutation committed. Everything
 * here is a no-op unless DOCS_SYNC_ENABLED is on, so flag-off behaviour is unchanged. The scan
 * (read) side lives in lib/doc-sync-scan.ts, which needs doc-fs and so cannot be imported here.
 */
import type { AppTransactionClient } from "@/lib/db"
import { buildTree } from "@/lib/doc-virtual-paths"

export type DocChangeKind = "UPSERT" | "MOVE" | "DELETE"

export function isDocsSyncEnabled(): boolean {
  const value = (process.env.DOCS_SYNC_ENABLED ?? "").trim().toLowerCase()
  return value === "1" || value === "true"
}

export function docRevisionOf(doc: { revision: string | null; updatedAt: Date }): string {
  return doc.revision ?? `legacy:${doc.updatedAt.toISOString()}`
}

type ChangeClient = Pick<AppTransactionClient, "doc" | "docChange">

/**
 * Appends change rows for `docId`. For MOVE the doc's descendants are recorded too, because their
 * virtual paths change with the ancestor. Call after the write for UPSERT/MOVE (so the path and
 * revision are the new ones) and BEFORE the row is removed for DELETE.
 *
 * Non-STANDARD docs (CANVAS, GTM briefs) are never logged: the sync surface is markdown only.
 */
export async function recordDocChange(tx: ChangeClient, workspaceId: string, docId: string, kind: DocChangeKind): Promise<void> {
  if (!isDocsSyncEnabled()) return
  const rows = await tx.doc.findMany({
    where: { workspaceId },
    select: { id: true, title: true, parentId: true, roadmapItemId: true, docType: true, updatedAt: true, revision: true, sortOrder: true, createdAt: true },
    orderBy: [{ parentId: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  })
  const nodes = buildTree(rows)
  const node = nodes.find((n) => n.docId === docId)
  if (!node || node.docType !== "STANDARD") return
  const revisions = new Map(rows.map((r) => [r.id, docRevisionOf(r)]))
  const affected = kind === "MOVE"
    ? nodes.filter((n) => n.docType === "STANDARD" && (n.docId === docId || n.path.startsWith(`${node.path}/`)))
    : [node]

  const last = await tx.docChange.findFirst({ where: { workspaceId }, orderBy: { seq: "desc" }, select: { seq: true } })
  const base = last?.seq ?? 0
  const now = new Date()
  await tx.docChange.createMany({
    data: affected.map((n, index) => ({
      workspaceId,
      docId: n.docId,
      seq: base + index + 1,
      kind: n.docId === docId ? kind : "MOVE",
      revision: revisions.get(n.docId) ?? null,
      path: n.path,
      deletedAt: kind === "DELETE" ? now : null,
      createdAt: now,
    })),
  })
}
