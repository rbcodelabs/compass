import { randomUUID } from "node:crypto"
import {
  BUNDLE_FORMAT_VERSION,
  BundleWriter,
  blobEntry,
  dataEntry,
  type BlobStoreName,
  type BundleManifest,
} from "@/lib/workspace-export/bundle"
import { DOC_IMAGE_URL, docImagePathname, type BlobAdapters } from "@/lib/workspace-export/blobs"
import { encodeRow } from "@/lib/workspace-export/codec"
import { SECRET_COLUMNS } from "@/lib/workspace-export/model-registry"
import {
  PARENT,
  delegateFor,
  exportOrder,
  modelHasId,
  modelHasWorkspaceId,
} from "@/lib/workspace-export/scope"

type Row = Record<string, unknown>
type Client = unknown

const PAGE = 500
const PART_ROWS = 20_000
const PART_BYTES = 8 * 1024 * 1024
const UUID_EXACT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class WorkspaceExportRefusal extends Error {}

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  heic: "image/heic",
  json: "application/json",
}
const mimeFor = (path: string) => MIME[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream"

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** Selects the rows of `model` that belong to the workspace, paged by id. */
async function* selectRows(
  client: Client,
  model: string,
  workspaceId: string,
  parentIds: (model: string) => string[],
): AsyncGenerator<Row[]> {
  const delegate = delegateFor(client, model)
  const hasId = modelHasId(model)
  const wheres: Row[] = []
  if (model === "Agent") wheres.push({ ownerType: "WORKSPACE", ownerWorkspaceId: workspaceId })
  else if (modelHasWorkspaceId(model)) wheres.push({ workspaceId })
  else {
    const parent = PARENT[model]
    if (!parent) throw new Error(`Model ${model} has no workspace scope`)
    for (const group of chunks(parentIds(parent.model), 200)) wheres.push({ [parent.fk]: { in: group } })
  }
  for (const where of wheres) {
    let cursor: string | undefined
    for (;;) {
      const rows = await delegate.findMany({
        where,
        take: PAGE,
        ...(hasId ? { orderBy: { id: "asc" }, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) } : {}),
      })
      if (rows.length) yield rows
      if (!hasId || rows.length < PAGE) break
      cursor = rows[rows.length - 1].id as string
    }
  }
}

/**
 * Streams a workspace bundle (zip). Secrets are stripped, runtime data is
 * excluded (see model-registry.ts). Throws WorkspaceExportRefusal for
 * workspaces that cannot be exported faithfully.
 */
export async function* exportWorkspaceChunks(
  client: Client,
  workspaceId: string,
  blobs: BlobAdapters,
): AsyncGenerator<Uint8Array> {
  const ws = (await delegateFor(client, "Workspace").findMany({ where: { id: workspaceId }, take: 1 }))[0]
  if (!ws) throw new WorkspaceExportRefusal("Workspace not found")
  const geode = await delegateFor(client, "Doc").count({ where: { workspaceId, storageProvider: "GEODE" } })
  if (geode > 0) {
    throw new WorkspaceExportRefusal("This workspace uses Geode-hosted documents, which cannot be exported yet.")
  }

  const writer = new BundleWriter()
  const exportedIds = new Set<string>([workspaceId])
  const idsByModel = new Map<string, string[]>()
  const referenced = new Set<string>()
  const counts: Record<string, number> = {}
  const warnings: string[] = []
  const blobList: BundleManifest["blobs"] = []
  const blobSeen = new Set<string>()
  const pendingBlobs: { store: BlobStoreName; key: string; contentType: string; source: () => Promise<Uint8Array | null> }[] = []

  const queueBlob = (store: BlobStoreName, key: string, contentType: string, source: () => Promise<Uint8Array | null>) => {
    const id = `${store}:${key}`
    if (blobSeen.has(id)) return
    blobSeen.add(id)
    pendingBlobs.push({ store, key, contentType, source })
  }

  const prepare = (model: string, raw: Row): Row => {
    const row = encodeRow(model, raw)
    for (const col of SECRET_COLUMNS[model] ?? []) if (col in row) row[col] = null
    for (const [name, v] of Object.entries(row)) {
      if (typeof v === "string" && name !== "id" && UUID_EXACT.test(v)) referenced.add(v.toLowerCase())
    }
    return row
  }

  const writeModel = async function* (model: string, source: AsyncGenerator<Row[]> | Row[][]) {
    let part = 0
    let lines: string[] = []
    let bytes = 0
    let total = 0
    const flush = function* () {
      if (!lines.length) return
      writer.addText(dataEntry(model, part++), lines.join("\n") + "\n")
      lines = []
      bytes = 0
      yield* writer.drain()
    }
    for await (const page of source as AsyncIterable<Row[]>) {
      for (const raw of page) {
        const row = prepare(model, raw)
        if (modelHasId(model)) {
          const id = row.id as string
          exportedIds.add(id.toLowerCase())
          const list = idsByModel.get(model) ?? []
          list.push(id)
          idsByModel.set(model, list)
        }
        const line = JSON.stringify(row)
        lines.push(line)
        bytes += line.length
        total++
        if (model === "ArtifactRevision") {
          for (const col of ["blobPathname", "thumbnailPathname"] as const) {
            const p = raw[col]
            if (typeof p === "string" && p) queueBlob("artifact", p, mimeFor(p), () => blobs.artifact.get(p))
          }
        } else if (model === "ResearchAttachment" && typeof raw.blobPathname === "string") {
          const p = raw.blobPathname
          queueBlob("research", p, mimeFor(p), () => blobs.research.get(p))
        } else if (model === "FeedbackAttachment" && typeof raw.url === "string") {
          const url = raw.url
          const type = typeof raw.fileType === "string" ? raw.fileType : "application/octet-stream"
          queueBlob("feedback", raw.id as string, type, async () => (await blobs.fetchPublic(url))?.bytes ?? null)
        } else if ((model === "Doc" || model === "DocVersion") && typeof raw.content === "string") {
          for (const m of raw.content.matchAll(DOC_IMAGE_URL)) {
            if (m[1].toLowerCase() !== workspaceId.toLowerCase()) continue
            const p = docImagePathname(m[1], m[2])
            queueBlob("artifact", p, mimeFor(p), () => blobs.artifact.get(p))
          }
        }
        if (lines.length >= PART_ROWS || bytes >= PART_BYTES) yield* flush()
      }
    }
    yield* flush()
    counts[model] = total
  }

  // Workspace root.
  yield* writeModel("Workspace", [[ws]])
  // Everything else, parents first.
  for (const model of exportOrder()) {
    yield* writeModel(model, selectRows(client, model, workspaceId, (m) => idsByModel.get(m) ?? []))
  }

  // Blobs, after data so the lists are complete.
  for (const b of pendingBlobs) {
    const bytes = await b.source()
    if (!bytes) {
      warnings.push(`Missing ${b.store} blob ${b.key}; the reference is kept but the file was not found`)
      continue
    }
    const compress = b.contentType.startsWith("text/") || b.contentType.includes("json")
    writer.add(blobEntry(b.store, b.key), bytes, compress)
    blobList.push({ store: b.store, key: b.key, contentType: b.contentType })
    yield* writer.drain()
  }

  // Referenced-but-not-exported ids that we can describe: users and org scoring models.
  const unresolved = [...referenced].filter((id) => !exportedIds.has(id))
  const users: BundleManifest["users"] = []
  const scoringModels: BundleManifest["scoringModels"] = []
  for (const group of chunks(unresolved, 500)) {
    for (const u of await delegateFor(client, "User").findMany({ where: { id: { in: group } }, select: { id: true, email: true, name: true } })) {
      if (typeof u.email === "string") users.push({ id: u.id as string, email: u.email, name: (u.name as string | null) ?? null })
    }
    for (const s of await delegateFor(client, "ScoringModel").findMany({ where: { id: { in: group } }, select: { id: true, organizationId: true } })) {
      scoringModels.push({ id: s.id as string, organizationId: s.organizationId as string })
    }
  }

  const manifest: BundleManifest = {
    formatVersion: BUNDLE_FORMAT_VERSION,
    exportId: randomUUID(),
    exportedAt: new Date().toISOString(),
    tier: "core",
    source: {
      workspaceId,
      organizationId: ws.organizationId as string,
      slug: ws.slug as string,
      name: ws.name as string,
    },
    counts,
    users,
    scoringModels,
    blobs: blobList,
    warnings,
  }
  writer.addText("manifest.json", JSON.stringify(manifest, null, 2))
  yield* writer.end()
}

export function exportWorkspaceStream(client: Client, workspaceId: string, blobs: BlobAdapters): ReadableStream<Uint8Array> {
  const it = exportWorkspaceChunks(client, workspaceId, blobs)
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await it.next()
        if (done) controller.close()
        else controller.enqueue(value)
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel() {
      await it.return(undefined)
    },
  })
}

export async function exportWorkspaceToBuffer(client: Client, workspaceId: string, blobs: BlobAdapters): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  for await (const c of exportWorkspaceChunks(client, workspaceId, blobs)) parts.push(c)
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

