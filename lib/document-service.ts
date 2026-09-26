/** Shared content boundary. Callers authorize workspace membership before entry. */
import { createHash, randomUUID } from "node:crypto"
import { Prisma, type Doc } from "@prisma/client"
import getPrisma, { type AppTransactionClient } from "@/lib/db"
import { getDocumentStore, isDocumentPilotWorkspace } from "@/lib/document-storage"

export type DocumentMutationOptions = {
  expectedRevision?: string
  operationId?: string
  authorId?: string | null
  authorName: string
  label?: string
  /** Internal target binding used by restore; never accepted from clients. */
  restoreVersionId?: string
  receiptDigest?: string
  actorKey?: string
}
type BodyRow = { content: string | null; storageProvider?: string | null; contentRef?: string | null }
type DocumentChange = {
  title?: string
  content?: string | null
  icon?: string | null
  metadata?: Prisma.InputJsonValue | typeof Prisma.JsonNull
  /** Reparent (doc-fs's movePath — ADR 0019). Null moves the doc to the workspace root. */
  parentId?: string | null
  sortOrder?: number
}

export class DocumentError extends Error {
  constructor(public readonly code: string) { super(`Document ${code}`); this.name = "DocumentError" }
}

function canonical(value: unknown): string {
  if (value === Prisma.JsonNull) return "null"
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`
}
function digest(value: unknown) { return createHash("sha256").update(canonical(value)).digest("hex") }
function requireOperation(opts: DocumentMutationOptions, requireRevision = true) {
  if (!opts.operationId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(opts.operationId)) throw new DocumentError("operation-id-required")
  if (requireRevision && !opts.expectedRevision) throw new DocumentError("revision-required")
}
function payload(type: string, id: string, data: unknown, opts: DocumentMutationOptions) {
  return digest({ type, id, data, expectedRevision: opts.expectedRevision, authorId: opts.authorId ?? null, authorName: opts.authorName, actorKey: opts.actorKey, label: opts.label, restoreVersionId: opts.restoreVersionId })
}
async function replay(workspaceId: string, operationId: string, payloadDigest: string, db = getPrisma()) {
  const receipt = await db.docOperation.findUnique({ where: { workspaceId_operationId: { workspaceId, operationId } } })
  if (!receipt) return null
  if (receipt.payloadDigest !== payloadDigest) throw new DocumentError("operation-conflict")
  const result = JSON.parse(receipt.result)
  if (result && typeof result === "object") {
    for (const key of ["createdAt", "updatedAt", "restoredFrom"]) {
      if (typeof result[key] === "string") {
        const date = new Date(result[key])
        if (!Number.isFinite(date.getTime())) throw new DocumentError("invalid-receipt")
        result[key] = date
      }
    }
  }
  return result
}
async function record(tx: AppTransactionClient, doc: Pick<Doc, "id" | "workspaceId">, operationId: string, payloadDigest: string, result: unknown) {
  await tx.docOperation.create({ data: { id: randomUUID(), workspaceId: doc.workspaceId, docId: doc.id, operationId, payloadDigest, result: JSON.stringify(result) } })
}
async function upload(workspaceId: string, content: string) {
  const result = await (await getDocumentStore(workspaceId)).putContent(content)
  if (result.status !== "ok") throw new DocumentError(result.status)
  return JSON.stringify(result.reference)
}

export async function hydrateDocument<T extends BodyRow>(workspaceId: string, row: T): Promise<Omit<T, "contentRef">> {
  const { contentRef, ...safe } = row
  if (row.storageProvider !== "GEODE") return safe
  if (!contentRef) throw new DocumentError("invalid-reference")
  let reference: unknown
  try { reference = JSON.parse(contentRef) } catch { throw new DocumentError("invalid-reference") }
  const result = await (await getDocumentStore(workspaceId)).readContent(reference)
  if (result.status !== "ok") throw new DocumentError(result.status)
  return { ...safe, content: result.text }
}

async function snapshot(tx: AppTransactionClient, doc: Doc, opts: DocumentMutationOptions) {
  if (!opts.label) {
    const latest = await tx.docVersion.findFirst({ where: { docId: doc.id }, orderBy: { createdAt: "desc" } })
    if (latest && Date.now() - latest.createdAt.getTime() < 300_000 && (latest.createdById ?? latest.createdByName) === (opts.authorId ?? opts.authorName)) return null
  }
  return tx.docVersion.create({ data: {
    docId: doc.id, title: doc.title, content: doc.content, metadata: doc.metadata ?? undefined,
    icon: doc.icon, ...(doc.storageProvider === "GEODE" ? { storageProvider: "GEODE", contentRef: doc.contentRef } : {}),
    label: opts.label, createdById: opts.authorId ?? null, createdByName: opts.authorName,
  } })
}

export async function createDocument(data: Prisma.DocUncheckedCreateInput, opts: DocumentMutationOptions) {
  const db = getPrisma()
  const pilot = isDocumentPilotWorkspace(data.workspaceId)
  const requestData = { ...data, sortOrder: undefined }
  const hash = payload("create", data.workspaceId, requestData, opts)
  if (pilot) {
    requireOperation(opts, false)
    const previous = await replay(data.workspaceId, opts.operationId!, hash)
    if (previous) return previous as Doc
  }
  // Validate references before any external storage write, including MCP calls.
  if (data.parentId && !await db.doc.findFirst({ where: { id: data.parentId, workspaceId: data.workspaceId } })) throw new DocumentError("parent-not-found")
  if (data.roadmapItemId && !await db.roadmapItem.findFirst({ where: { id: data.roadmapItemId, workspaceId: data.workspaceId } })) throw new DocumentError("roadmap-item-not-found")
  // Every doc gets a revision from creation, regardless of storage provider
  // (ADR 0019 §2.1), so the very first mutation after this change has
  // something real to compare `expectedRevision` against. This is additive:
  // a caller that never supplies `expectedRevision` (today's UI autosave,
  // today's legacy MCP handlers) keeps exactly today's last-write-wins update
  // path below, untouched.
  if (!pilot) return db.doc.create({ data: { ...data, revision: randomUUID() } })
  const contentRef = await upload(data.workspaceId, data.content ?? "")
  try {
    return await db.$transaction(async tx => {
      const doc = await tx.doc.create({ data: { ...data, storageProvider: "GEODE", content: null, contentRef, revision: randomUUID() } })
      await record(tx, doc, opts.operationId!, hash, doc)
      return doc
    })
  } catch (error) {
    const previous = await replay(data.workspaceId, opts.operationId!, hash)
    if (previous) return previous as Doc
    throw error
  }
}

export async function updateDocument(docId: string, data: DocumentChange, opts: DocumentMutationOptions): Promise<Doc> {
  const db = getPrisma()
  const doc = await db.doc.findUnique({ where: { id: docId } })
  if (!doc) throw new DocumentError("not-found")
  if (doc.storageProvider !== "GEODE") {
    // ADR 0019 §2.1: extend the GEODE-only optimistic-concurrency check to
    // every doc, but only when the caller actually supplies expectedRevision.
    // A caller that omits it (today's UI autosave, today's legacy MCP
    // handlers until migrated) keeps exactly today's last-write-wins
    // behavior -- additive, not breaking. doc-fs.ts is the first caller that
    // always supplies it.
    if (opts.expectedRevision !== undefined) {
      return db.$transaction(async tx => {
        if (Object.keys(data).length) await snapshot(tx, doc, opts)
        const revision = randomUUID()
        const changed = await tx.doc.updateMany({
          where: { id: docId, workspaceId: doc.workspaceId, revision: opts.expectedRevision },
          data: { ...data, revision, updatedAt: new Date() },
        })
        if (changed.count !== 1) throw new DocumentError("revision-conflict")
        const updated = await tx.doc.findUnique({ where: { id: docId } })
        if (!updated) throw new DocumentError("not-found")
        return updated
      })
    }
    return db.$transaction(async tx => {
      if (Object.keys(data).length) await snapshot(tx, doc, opts)
      return tx.doc.update({ where: { id: docId }, data: { ...data, revision: randomUUID(), updatedAt: new Date() } })
    })
  }
  requireOperation(opts)
  const hash = opts.receiptDigest ?? payload("update", docId, data, opts)
  const previous = await replay(doc.workspaceId, opts.operationId!, hash)
  if (previous) return previous as Doc
  if (doc.revision !== opts.expectedRevision) throw new DocumentError("revision-conflict")
  const contentRef = data.content !== undefined ? await upload(doc.workspaceId, data.content ?? "") : doc.contentRef
  try {
    return await db.$transaction(async tx => {
      const revision = randomUUID()
      const changed = await tx.doc.updateMany({ where: { id: docId, workspaceId: doc.workspaceId, revision: opts.expectedRevision }, data: { ...data, content: null, contentRef, revision, updatedAt: new Date() } })
      if (changed.count !== 1) throw new DocumentError("revision-conflict")
      await snapshot(tx, doc, opts)
      const updated = await tx.doc.findUnique({ where: { id: docId } })
      if (!updated) throw new DocumentError("not-found")
      await record(tx, doc, opts.operationId!, hash, updated)
      return updated
    })
  } catch (error) {
    const previous = await replay(doc.workspaceId, opts.operationId!, hash)
    if (previous) return previous as Doc
    throw error
  }
}

export async function snapshotDocument(docId: string, opts: DocumentMutationOptions) {
  const db = getPrisma()
  const doc = await db.doc.findUnique({ where: { id: docId } })
  if (!doc) throw new DocumentError("not-found")
  if (doc.storageProvider !== "GEODE") return db.$transaction(tx => snapshot(tx, doc, opts))
  requireOperation(opts)
  const hash = payload("snapshot", docId, {}, opts)
  const previous = await replay(doc.workspaceId, opts.operationId!, hash)
  if (previous) return previous
  if (doc.revision !== opts.expectedRevision) throw new DocumentError("revision-conflict")
  try { return await db.$transaction(async tx => {
    // Touch the same revision to participate in DSQL's write-conflict detection.
    const changed = await tx.doc.updateMany({ where: { id: docId, workspaceId: doc.workspaceId, revision: opts.expectedRevision }, data: { revision: opts.expectedRevision } })
    if (changed.count !== 1) throw new DocumentError("revision-conflict")
    const version = await snapshot(tx, doc, { ...opts, label: opts.label || "Snapshot" })
    await record(tx, doc, opts.operationId!, hash, version)
    return version
  }) } catch (error) {
    const previous = await replay(doc.workspaceId, opts.operationId!, hash)
    if (previous) return previous
    throw error
  }
}

export async function restoreDocument(versionId: string, opts: DocumentMutationOptions) {
  const db = getPrisma()
  const version = await db.docVersion.findUnique({ where: { id: versionId } })
  if (!version) return null
  const doc = await db.doc.findUnique({ where: { id: version.docId } })
  if (!doc) return null
  const hash = payload("restore", versionId, {}, opts)
  if (doc.storageProvider === "GEODE") {
    requireOperation(opts)
    const previous = await replay(doc.workspaceId, opts.operationId!, hash)
    if (previous) return { id: previous.id, docId: doc.id, title: previous.title, revision: previous.revision, restoredFrom: version.createdAt }
  }
  const hydrated = await hydrateDocument(doc.workspaceId, version)
  const restored = await updateDocument(doc.id, { title: version.title, content: hydrated.content, icon: version.icon, metadata: version.metadata === null ? Prisma.JsonNull : version.metadata as Prisma.InputJsonValue }, { ...opts, label: "Before restore", restoreVersionId: versionId, receiptDigest: hash })
  return { id: restored.id, docId: doc.id, title: restored.title, revision: restored.revision, restoredFrom: version.createdAt }
}

export async function deleteDocument(docId: string, opts: DocumentMutationOptions & { workspaceId?: string }) {
  const db = getPrisma()
  const doc = await db.doc.findUnique({ where: { id: docId } })
  const workspaceId = doc?.workspaceId ?? opts.workspaceId
  if (!workspaceId) throw new DocumentError("not-found")
  const hash = payload("delete", docId, {}, opts)
  if (opts.operationId && await replay(workspaceId, opts.operationId, hash)) return
  if (!doc) throw new DocumentError("not-found")
  if (doc.storageProvider === "GEODE") requireOperation(opts)
  try { await db.$transaction(async tx => {
    // ADR 0019 §2.1: same expectedRevision extension as updateDocument -- GEODE
    // always supplies one (requireOperation above enforces that); any other
    // caller only pays the guard when it actually asks for one.
    if (doc.storageProvider === "GEODE" || opts.expectedRevision !== undefined) {
      const changed = await tx.doc.updateMany({ where: { id: docId, workspaceId, revision: opts.expectedRevision }, data: { revision: randomUUID() } })
      if (changed.count !== 1) throw new DocumentError("revision-conflict")
    }
    if (await tx.doc.findFirst({ where: { parentId: docId } })) throw new DocumentError("has-children")
    await tx.docVersion.deleteMany({ where: { docId } })
    await tx.docComment.deleteMany({ where: { docId } })
    await tx.doc.delete({ where: { id: docId } })
    if (doc.storageProvider === "GEODE") await record(tx, doc, opts.operationId!, hash, { deleted: true })
  }) } catch (error) {
    if (opts.operationId && await replay(workspaceId, opts.operationId, hash)) return
    throw error
  }
}
