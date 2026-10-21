/**
 * Geode doc sync, rollout step 2: the mutation endpoints behind /sync/docs. Thin, strict adapters over
 * lib/doc-fs.ts (which owns path semantics) and lib/document-service.ts (which owns revisions,
 * idempotency receipts and the change-log writes), so every mutation lands in the next delta scan.
 *
 * Contract (the Geode plugin is built against it):
 *   - Paths are Geode file paths and MUST end in ".md"; the extension is stripped to get the doc-fs
 *     path ("Folder/Note.md" <-> "Folder/Note"). Anything else is 422 `unsupported_extension`.
 *     Entries are returned with the SAME path form the scan uses (no extension).
 *   - Only in-scope docs (STANDARD, no CANVAS/GTM ancestor) are addressable; anything else is 404.
 *   - expectedRevision is required for update / move / delete; a stale one is 409 `revision_conflict`.
 *   - operationKey (create, update) maps to a deterministic DocOperation id, so retrying the same
 *     request replays the first result. The same key with different input is 409 `operation_conflict`.
 *   - There are no folder endpoints: a "folder" is a doc with children. Creating "A/B/Note.md" creates
 *     the missing parents (body-less docs, reported as `folder` by the scan) implicitly. Deleting a doc
 *     that still has children is 409 `has_children`, so clients delete leaves first.
 */
import getPrisma from "@/lib/db"
import { buildTree, syncScopeRows } from "@/lib/doc-virtual-paths"
import { DocFsError, createPath, deleteDocById, deriveOperationId, listPaths, moveDocById, sanitizeTitleSegment, writeDocById } from "@/lib/doc-fs"
import { DocumentError } from "@/lib/document-service"
import { documentMcpActor } from "@/lib/document-mcp-actor"
import { isDocsSyncEnabled } from "@/lib/doc-sync"
import { DocSyncDisabledError, buildEntry, loadTreeRows, type DocSyncEntry } from "@/lib/doc-sync-scan"

export class SyncMutationError extends Error {
  constructor(public readonly status: 404 | 409 | 422, public readonly code: string, message: string) {
    super(message)
    this.name = "SyncMutationError"
  }
}

export type SyncMutationEntry = DocSyncEntry & { operationKey?: string }
export type SyncDocRead = DocSyncEntry & { content: string }

const AUTHOR = "Geode sync"

function requireEnabled() {
  if (!isDocsSyncEnabled()) throw new DocSyncDisabledError()
}

/** "Folder/Note.md" -> "Folder/Note". Strict: the extension must be .md. */
export function toDocFsPath(path: string): string {
  if (!/\.md$/i.test(path)) throw new SyncMutationError(422, "unsupported_extension", `Only .md files can be synced; got "${path}".`)
  const stripped = path.replace(/\.md$/i, "")
  const segments = stripped.split("/")
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.trim() === "")) throw new SyncMutationError(422, "invalid_path", `Invalid path: "${path}".`)
  return stripped
}

function operationIdFor(workspaceId: string, kind: string, key: string): string {
  return deriveOperationId("doc-sync", `${workspaceId}:${kind}:${key}`)
}

/** Maps the lower layers' typed failures to the endpoint contract; anything unknown is rethrown. */
function translate(error: unknown): never {
  if (error instanceof SyncMutationError) throw error
  if (error instanceof DocumentError) {
    if (error.code === "revision-conflict") throw new SyncMutationError(409, "revision_conflict", "The expected revision is stale.")
    if (error.code === "operation-conflict") throw new SyncMutationError(409, "operation_conflict", "That operationKey was already used with different input.")
    if (error.code === "has-children") throw new SyncMutationError(409, "has_children", "The doc still has children; delete them first.")
    if (error.code === "not-found") throw new SyncMutationError(404, "not_found", "Doc not found.")
  }
  if (error instanceof DocFsError) {
    if (error.code === "exists") throw new SyncMutationError(409, "path_conflict", "A doc already exists at that path.")
    if (error.code === "has-children") throw new SyncMutationError(409, "has_children", "The doc still has children; delete them first.")
    if (error.code === "not-found") throw new SyncMutationError(404, "not_found", "Doc not found.")
    if (error.code === "invalid-path") throw new SyncMutationError(422, "invalid_path", error.message)
    if (error.code === "invalid-move") throw new SyncMutationError(422, "invalid_move", error.message)
  }
  throw error
}

async function inScopeNodes(workspaceId: string) {
  return buildTree(syncScopeRows(await loadTreeRows(workspaceId)))
}

async function loadEntry(workspaceId: string, docId: string): Promise<{ entry: DocSyncEntry; text: string }> {
  const node = (await inScopeNodes(workspaceId)).find((n) => n.docId === docId)
  const doc = node ? await getPrisma().doc.findFirst({ where: { id: docId, workspaceId } }) : null
  if (!node || !doc) throw new SyncMutationError(404, "not_found", "Doc not found.")
  return buildEntry(workspaceId, doc, node)
}

/**
 * The target path must be creatable inside the sync scope: no existing ancestor, and not the path
 * itself, may be a doc that is out of scope (a canvas, a GTM brief, anything under one).
 */
async function assertTargetInScope(workspaceId: string, docFsPath: string): Promise<void> {
  const [all, inScope] = await Promise.all([listPaths(workspaceId), inScopeNodes(workspaceId)])
  const scoped = new Set(inScope.map((n) => n.docId))
  const byPath = new Map(all.map((n) => [n.path, n]))
  const segments = docFsPath.split("/").map(sanitizeTitleSegment)
  for (let i = 1; i <= segments.length; i++) {
    const existing = byPath.get(segments.slice(0, i).join("/"))
    if (existing && !scoped.has(existing.docId)) throw new SyncMutationError(409, "path_conflict", "That path is occupied by a doc outside the sync scope.")
  }
}

export async function getSyncDoc(workspaceId: string, docId: string, revision?: string): Promise<SyncDocRead> {
  requireEnabled()
  const { entry, text } = await loadEntry(workspaceId, docId)
  if (revision !== undefined && revision !== entry.revision) throw new SyncMutationError(409, "revision_conflict", "The doc is no longer at that revision.")
  return { ...entry, content: text }
}

export async function createSyncDoc(workspaceId: string, input: { path: string; content: string; operationKey: string }): Promise<SyncMutationEntry> {
  requireEnabled()
  const docFsPath = toDocFsPath(input.path)
  try {
    await assertTargetInScope(workspaceId, docFsPath)
    const created = await createPath(workspaceId, docFsPath, input.content, { operationId: operationIdFor(workspaceId, "create", input.operationKey), ...documentMcpActor(AUTHOR) })
    return { ...(await loadEntry(workspaceId, created.docId)).entry, operationKey: input.operationKey }
  } catch (error) { return translate(error) }
}

export async function updateSyncDoc(workspaceId: string, docId: string, input: { content: string; expectedRevision: string; operationKey: string }): Promise<SyncMutationEntry> {
  requireEnabled()
  try {
    await loadEntry(workspaceId, docId) // 404 when absent or out of scope
    await writeDocById(workspaceId, docId, input.content, { operationId: operationIdFor(workspaceId, "update", input.operationKey), expectedRevision: input.expectedRevision, ...documentMcpActor(AUTHOR) })
    return { ...(await loadEntry(workspaceId, docId)).entry, operationKey: input.operationKey }
  } catch (error) { return translate(error) }
}

export async function moveSyncDoc(workspaceId: string, docId: string, input: { path: string; expectedRevision: string }): Promise<SyncMutationEntry> {
  requireEnabled()
  const docFsPath = toDocFsPath(input.path)
  try {
    const current = await loadEntry(workspaceId, docId)
    // Checked up front: moving first creates missing parent docs, which a stale request must not leave behind.
    if (current.entry.revision !== input.expectedRevision) throw new SyncMutationError(409, "revision_conflict", "The expected revision is stale.")
    const normalized = docFsPath.split("/").map(sanitizeTitleSegment).join("/")
    if (current.entry.path === normalized) return current.entry
    const occupant = (await inScopeNodes(workspaceId)).find((n) => n.path === normalized && n.docId !== docId)
    if (occupant) throw new SyncMutationError(409, "path_conflict", "A doc already exists at that path.")
    await assertTargetInScope(workspaceId, docFsPath)
    await moveDocById(workspaceId, docId, docFsPath, { expectedRevision: input.expectedRevision, ...documentMcpActor(AUTHOR) })
    return (await loadEntry(workspaceId, docId)).entry
  } catch (error) { return translate(error) }
}

export async function deleteSyncDoc(workspaceId: string, docId: string, expectedRevision: string): Promise<void> {
  requireEnabled()
  try {
    const current = await loadEntry(workspaceId, docId)
    if (current.entry.revision !== expectedRevision) throw new SyncMutationError(409, "revision_conflict", "The expected revision is stale.")
    await deleteDocById(workspaceId, docId, { expectedRevision, operationId: operationIdFor(workspaceId, "delete", `${docId}:${expectedRevision}`), ...documentMcpActor(AUTHOR) })
  } catch (error) { return translate(error) }
}
