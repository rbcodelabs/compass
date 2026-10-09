/**
 * Server-side read-modify-write for a doc's body.
 *
 * MCP edit tools (edit_doc, edit_canvas, build_canvas_tree) send a small *intent* instead of the
 * whole document. This helper loads the current body, lets the caller transform it, and writes the
 * result through `updateDocument` with a compare-and-swap on the revision and a fresh operation id,
 * so a concurrent writer can never be silently overwritten:
 *
 *  - If the caller pinned `expectedRevision`, it is enforced strictly: any drift is a conflict the
 *    caller must resolve (re-read, re-plan).
 *  - Otherwise the edit is re-applied on top of whatever is current, a few times, before giving up.
 *    The intents are expressed against stable identifiers (text to match, node ids), not against a
 *    snapshot, so re-applying on a newer revision is safe and the transform re-validates each time.
 */
import { randomUUID } from "node:crypto"
import getPrisma from "@/lib/db"
import { DocumentError, documentRevision, hydrateDocument, updateDocument } from "@/lib/document-service"
import { documentMcpActor } from "@/lib/document-mcp-actor"
import type { DocType } from "@/lib/doc-types"

export const MAX_EDIT_ATTEMPTS = 4

export type EditableDoc = {
  id: string
  workspaceId: string
  title: string
  docType: DocType
  /** Stored body (frontmatter lives in `metadata`, not here). */
  content: string
  revision: string
}

export type TransformResult<T> = { ok: true; content: string; result: T } | { ok: false; error: string }

export type EditOutcome<T> =
  | { ok: true; doc: { id: string; title: string; revision: string; updatedAt: Date }; result: T; attempts: number; changed: boolean }
  | { ok: false; code: "not-found" | "revision-conflict" | "rejected"; error: string }

export async function editDocumentBody<T>(
  docId: string,
  transform: (doc: EditableDoc) => TransformResult<T> | Promise<TransformResult<T>>,
  options: { expectedRevision?: string; authorName?: string } = {}
): Promise<EditOutcome<T>> {
  const pinned = options.expectedRevision
  for (let attempt = 1; attempt <= (pinned ? 1 : MAX_EDIT_ATTEMPTS); attempt++) {
    const row = await getPrisma().doc.findUnique({ where: { id: docId } })
    if (!row) return { ok: false, code: "not-found", error: `Doc "${docId}" not found.` }
    const revision = documentRevision(row)
    if (pinned && pinned !== revision) {
      return { ok: false, code: "revision-conflict", error: `Doc changed since revision ${pinned} (now ${revision}). Re-read it with get_doc and retry.` }
    }
    const hydrated = await hydrateDocument(row.workspaceId, row)
    const current: EditableDoc = {
      id: row.id,
      workspaceId: row.workspaceId,
      title: row.title,
      docType: row.docType as DocType,
      content: hydrated.content ?? "",
      revision,
    }
    const transformed = await transform(current)
    if (!transformed.ok) return { ok: false, code: "rejected", error: transformed.error }
    if (transformed.content === current.content) {
      return { ok: true, doc: { id: row.id, title: row.title, revision, updatedAt: row.updatedAt }, result: transformed.result, attempts: attempt, changed: false }
    }
    try {
      const updated = await updateDocument(
        docId,
        { content: transformed.content },
        { expectedRevision: revision, operationId: randomUUID(), ...documentMcpActor(options.authorName) }
      )
      return { ok: true, doc: { id: updated.id, title: updated.title, revision: documentRevision(updated), updatedAt: updated.updatedAt }, result: transformed.result, attempts: attempt, changed: true }
    } catch (error) {
      if (error instanceof DocumentError && error.code === "revision-conflict") {
        if (pinned || attempt === MAX_EDIT_ATTEMPTS) {
          return { ok: false, code: "revision-conflict", error: pinned ? `Doc changed since revision ${pinned}. Re-read it with get_doc and retry.` : `Doc kept changing underneath this edit (${MAX_EDIT_ATTEMPTS} attempts). Retry in a moment.` }
        }
        continue
      }
      if (error instanceof DocumentError && error.code === "invalid-canvas") return { ok: false, code: "rejected", error: error.message }
      throw error
    }
  }
  return { ok: false, code: "revision-conflict", error: "Doc kept changing underneath this edit. Retry in a moment." }
}
