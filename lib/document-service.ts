/** Shared content boundary. Callers authorize workspace membership before entry. */
import { createHash, randomUUID } from "node:crypto"
import { Prisma, type Doc } from "@prisma/client"
import getPrisma, { type AppTransactionClient } from "@/lib/db"
import { getDocumentStore, isDocumentPilotWorkspace } from "@/lib/document-storage"
import { normalizeCanvasContent } from "@/lib/json-canvas"

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
type DocumentChange = { title?: string; content?: string | null; icon?: string | null; metadata?: Prisma.InputJsonValue | typeof Prisma.JsonNull }

export class DocumentError extends Error {
  constructor(public readonly code: string, detail?: string) { super(detail ? `Document ${code}: ${detail}` : `Document ${code}`); this.name = "DocumentError" }
}

/** CANVAS docs store a JSON Canvas document; reject anything that is not one before it reaches storage. */
function canonicalCanvasContent(content: string | null | undefined): string {
  const result = normalizeCanvasContent(content ?? "")
  if (!result.ok) throw new DocumentError("invalid-canvas", result.error)
  return result.content
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
  return digest({ type, id, data, expectedRevision: opts.expectedRevision, actorKey: opts.actorKey ?? `user:${opts.authorId ?? "unknown"}`, label: opts.label, restoreVersionId: opts.restoreVersionId })
}
export function documentRevision(doc: Pick<Doc, "revision" | "updatedAt">): string {
  return doc.revision ?? `legacy:${doc.updatedAt.toISOString()}`
}
function revisionWhere(doc: Pick<Doc, "revision" | "updatedAt">, expectedRevision: string) {
  return doc.revision ? { revision: expectedRevision } : { revision: null, updatedAt: doc.updatedAt }
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

export async function createDocument(input: Prisma.DocUncheckedCreateInput, opts: DocumentMutationOptions) {
  const db = getPrisma()
  const data = input.docType === "CANVAS" ? { ...input, content: canonicalCanvasContent(input.content) } : input
  const pilot = isDocumentPilotWorkspace(data.workspaceId)
  const guarded = pilot || Boolean(opts.operationId)
  const requestData = { ...data, sortOrder: undefined }
  const hash = payload("create", data.workspaceId, requestData, opts)
  if (guarded) {
    requireOperation(opts, false)
    const previous = await replay(data.workspaceId, opts.operationId!, hash)
    if (previous) return previous as Doc
  }
  // Validate references before any external storage write, including MCP calls.
  if (data.parentId && !await db.doc.findFirst({ where: { id: data.parentId, workspaceId: data.workspaceId } })) throw new DocumentError("parent-not-found")
  if (data.roadmapItemId && !await db.roadmapItem.findFirst({ where: { id: data.roadmapItemId, workspaceId: data.workspaceId } })) throw new DocumentError("roadmap-item-not-found")
  const contentRef = pilot ? await upload(data.workspaceId, data.content ?? "") : null
  try {
    return await db.$transaction(async tx => {
      const doc = await tx.doc.create({ data: pilot
        ? { ...data, storageProvider: "GEODE", content: null, contentRef, revision: randomUUID() }
        : { ...data, revision: randomUUID() } })
      if (guarded) await record(tx, doc, opts.operationId!, hash, doc)
      return doc
    })
  } catch (error) {
    if (guarded) {
      const previous = await replay(data.workspaceId, opts.operationId!, hash)
      if (previous) return previous as Doc
    }
    throw error
  }
}

export async function updateDocument(docId: string, change: DocumentChange, opts: DocumentMutationOptions): Promise<Doc> {
  const db = getPrisma()
  const doc = await db.doc.findUnique({ where: { id: docId } })
  if (!doc) throw new DocumentError("not-found")
  const data = doc.docType === "CANVAS" && typeof change.content === "string" ? { ...change, content: canonicalCanvasContent(change.content) } : change
  if (doc.storageProvider !== "GEODE" && !opts.operationId) {
    return db.$transaction(async tx => {
      if (Object.keys(data).length) await snapshot(tx, doc, opts)
      return tx.doc.update({ where: { id: docId }, data: { ...data, revision: randomUUID(), updatedAt: new Date() } })
    })
  }
  requireOperation(opts)
  const hash = opts.receiptDigest ?? payload("update", docId, data, opts)
  const previous = await replay(doc.workspaceId, opts.operationId!, hash)
  if (previous) return previous as Doc
  if (documentRevision(doc) !== opts.expectedRevision) throw new DocumentError("revision-conflict")
  const contentRef = doc.storageProvider === "GEODE" && data.content !== undefined ? await upload(doc.workspaceId, data.content ?? "") : doc.contentRef
  try {
    return await db.$transaction(async tx => {
      const revision = randomUUID()
      const changed = await tx.doc.updateMany({ where: { id: docId, workspaceId: doc.workspaceId, ...revisionWhere(doc, opts.expectedRevision!) }, data: doc.storageProvider === "GEODE"
        ? { ...data, content: null, contentRef, revision, updatedAt: new Date() }
        : { ...data, revision, updatedAt: new Date() } })
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
  if (doc.storageProvider !== "GEODE" && !opts.operationId) return db.$transaction(tx => snapshot(tx, doc, opts))
  requireOperation(opts)
  const hash = payload("snapshot", docId, {}, opts)
  const previous = await replay(doc.workspaceId, opts.operationId!, hash)
  if (previous) return previous
  if (documentRevision(doc) !== opts.expectedRevision) throw new DocumentError("revision-conflict")
  try { return await db.$transaction(async tx => {
    // Touch the same revision to participate in DSQL's write-conflict detection.
    const changed = await tx.doc.updateMany({ where: { id: docId, workspaceId: doc.workspaceId, ...revisionWhere(doc, opts.expectedRevision!) }, data: { revision: doc.revision ?? randomUUID() } })
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
  if (doc.storageProvider === "GEODE" || opts.operationId) {
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
    if (doc.storageProvider === "GEODE") {
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
