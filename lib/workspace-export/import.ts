import { createHash, randomUUID } from "node:crypto"
import { isDsqlWriteConflict } from "@/lib/dsql-conflict"
import { normalizeWorkspaceRole } from "@/lib/roles"
import { SLUG_PATTERN, isReservedWorkspaceSlug } from "@/lib/slug"
import { WORK_ITEM_REGISTRY, WORK_ITEM_TYPES } from "@/lib/work-item-ids"
import { BundleReader, blobEntry, type BundleManifest } from "@/lib/workspace-export/bundle"
import { type BlobAdapters } from "@/lib/workspace-export/blobs"
import { decodeRow, fieldInfo } from "@/lib/workspace-export/codec"
import { OPTIONAL_STRING_FIELDS } from "@/lib/workspace-export/schema-meta.generated"
import { IMPORT_OVERRIDES, SECRET_COLUMNS } from "@/lib/workspace-export/model-registry"
import {
  PARENT,
  delegateFor,
  dmmfModels,
  exportOrder,
  modelHasId,
  modelHasWorkspaceId,
} from "@/lib/workspace-export/scope"

type Row = Record<string, unknown>
type Client = unknown

const CHUNK = 200
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const UUID_EXACT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Exact-UUID columns that point at systems outside the export and are kept verbatim. */
const KEEP_COLUMNS = new Set(["authorityRecordId", "v0VersionId", "applicationReceiptId"])
/**
 * Required columns that reference an org-level row outside the export. If it cannot be resolved in the target
 * organization the row is skipped rather than left pointing at another organization's data.
 */
const DROP_ON_UNRESOLVED = new Set([
  "OpportunityScore.scoringModelId",
  "SolutionScore.scoringModelId",
  // Link and polymorphic endpoints: a row whose target is not part of the import would point into another workspace.
  "EntityLink.fromId",
  "EntityLink.toId",
  "TaskLink.linkedId",
  "ArtifactLink.linkedId",
  "OpportunityObjectiveLink.opportunityId",
  "OpportunityObjectiveLink.objectiveId",
  "SolutionKeyResultLink.solutionId",
  "SolutionKeyResultLink.keyResultId",
  "Comment.targetId",
  "CanvasNodePosition.entityId",
  "CustomFieldValue.objectId",
  "CardSortProposal.objectId",
  "DecisionApplication.targetId",
  "MetricBinding.targetId",
  "Follow.subjectId",
])
/**
 * Content columns that are unique across the WHOLE database (not per workspace) and so would collide with the
 * source rows. They are rewritten to a per-import hash; the value is only ever compared for equality.
 */
const REKEY_COLUMNS = new Set(["DecisionRecord.idempotencyKey", "DecisionApplication.receiptKey", "MetricObservation.refreshKey"])
const MAX_ROWS_PER_MODEL = 2_000_000

export class WorkspaceImportError extends Error {}

export type ImportOptions = {
  organizationId: string
  importerUserId: string
  name?: string
  slug?: string
  /** Retrying with the same nonce resumes the same import; a new nonce makes a fresh copy. */
  nonce?: string
  blobs: BlobAdapters
}

export type ImportReport = {
  workspaceId: string
  slug: string
  name: string
  alreadyImported: boolean
  counts: Record<string, number>
  usersMatched: number
  usersFallbackToImporter: number
  referencesCleared: number
  blobsCopied: number
  warnings: string[]
}

function alreadyImportedReport(workspace: Row, manifest: BundleManifest): ImportReport {
  return {
    workspaceId: workspace.id as string,
    slug: workspace.slug as string,
    name: workspace.name as string,
    alreadyImported: true,
    counts: manifest.counts,
    usersMatched: 0,
    usersFallbackToImporter: 0,
    referencesCleared: 0,
    blobsCopied: 0,
    warnings: [],
  }
}

function deriveId(importKey: string, oldId: string): string {
  const h = createHash("sha256").update(`${importKey}:${oldId.toLowerCase()}`).digest("hex")
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= 5 || !isDsqlWriteConflict(error)) throw error
      await new Promise((r) => setTimeout(r, 50 * 2 ** attempt))
    }
  }
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

const BUNDLE_DATA_ENTRY = /^data\/([A-Za-z]+)\.\d{4}\.ndjson$/

/** Models a bundle may contain. Anything else (User, ApiKey, ...) is rejected: a crafted bundle must not write outside the content set. */
function allowedModels(): Set<string> {
  return new Set(["Workspace", ...exportOrder()])
}

export async function importWorkspaceBundle(client: Client, bytes: Uint8Array, opts: ImportOptions): Promise<ImportReport> {
  let reader: BundleReader
  try {
    reader = new BundleReader(bytes)
  } catch {
    throw new WorkspaceImportError("The file is not a valid workspace bundle (not a readable zip)")
  }
  let manifest: BundleManifest
  try {
    manifest = reader.manifest()
  } catch (e) {
    throw new WorkspaceImportError((e as Error).message)
  }

  const allowed = allowedModels()
  for (const name of reader.list("data/")) {
    const m = BUNDLE_DATA_ENTRY.exec(name)
    if (!m || !allowed.has(m[1]) || !dmmfModels.has(m[1])) {
      throw new WorkspaceImportError(`Bundle contains an unexpected data entry: ${name}`)
    }
  }

  const org = await delegateFor(client, "Organization").findMany({ where: { id: opts.organizationId }, take: 1 })
  if (!org[0]) throw new WorkspaceImportError("Target organization not found")

  // ---- identity: every exported row id gets a deterministic new id ---------------------------------------------------
  const importKey = createHash("sha256")
    .update(`${manifest.exportId}:${opts.organizationId}:${opts.nonce ?? randomUUID()}`)
    .digest("hex")
  const idSet = new Set<string>([manifest.source.workspaceId.toLowerCase()])
  for (const model of ["Workspace", ...exportOrder()]) {
    if (!modelHasId(model)) continue
    let n = 0
    for (const row of reader.rows(model)) {
      if (++n > MAX_ROWS_PER_MODEL) throw new WorkspaceImportError(`Too many ${model} rows`)
      if (typeof row.id === "string") idSet.add(row.id.toLowerCase())
    }
  }
  const newWorkspaceId = deriveId(importKey, manifest.source.workspaceId)

  const existing = await delegateFor(client, "Workspace").findMany({ where: { id: newWorkspaceId }, take: 1 })
  if (existing[0]) return alreadyImportedReport(existing[0], manifest)

  // ---- users: match by email, fall back to the importer ---------------------------------------------------------------
  const members = (await delegateFor(client, "OrganizationMember").findMany({
    where: { organizationId: opts.organizationId },
    select: { userId: true, role: true },
  })) as { userId: string; role: string }[]
  const memberUsers = (await delegateFor(client, "User").findMany({
    where: { id: { in: members.map((m) => m.userId) } },
    select: { id: true, email: true },
  })) as { id: string; email: string | null }[]
  const byEmail = new Map(memberUsers.filter((u) => u.email).map((u) => [u.email!.toLowerCase(), u.id]))
  const userMap = new Map<string, string>()
  let usersMatched = 0
  let usersFallback = 0
  for (const u of manifest.users) {
    const target = byEmail.get(u.email.toLowerCase())
    if (target) usersMatched++
    else usersFallback++
    userMap.set(u.id.toLowerCase(), target ?? opts.importerUserId)
  }
  const keep = new Set(manifest.scoringModels.filter((s) => s.organizationId === opts.organizationId).map((s) => s.id.toLowerCase()))

  const mapUuid = (value: string): string | undefined => {
    const k = value.toLowerCase()
    if (idSet.has(k)) return deriveId(importKey, k)
    const u = userMap.get(k)
    if (u) return u
    if (keep.has(k)) return value
    return undefined
  }
  const rewriteText = (text: string): string => text.replace(UUID_ANY, (m) => mapUuid(m) ?? m)
  const rewriteDeep = (v: unknown): unknown => {
    if (typeof v === "string") return rewriteText(v)
    if (Array.isArray(v)) return v.map(rewriteDeep)
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewriteDeep(x)]))
    return v
  }

  // ---- naming ------------------------------------------------------------------------------------------------------------
  const wsDelegate = delegateFor(client, "Workspace")
  const baseName = (opts.name ?? `${manifest.source.name} (imported)`).trim()
  if (!baseName) throw new WorkspaceImportError("Workspace name is required")
  let slug = (opts.slug ?? `${manifest.source.slug.slice(0, 80)}-imported`).trim().toLowerCase()
  if (!SLUG_PATTERN.test(slug)) throw new WorkspaceImportError("Slug may only contain lowercase letters, numbers and hyphens")
  if (slug.length > 100) throw new WorkspaceImportError("Slug must be 100 characters or fewer")
  const requestedReserved = isReservedWorkspaceSlug(slug) ? slug : null
  if (requestedReserved) slug = `${slug}-workspace`
  if (!opts.slug) {
    const base = slug
    for (let i = 2; (await wsDelegate.count({ where: { organizationId: opts.organizationId, slug } })) > 0; i++) slug = `${base}-${i}`
  } else if ((await wsDelegate.count({ where: { organizationId: opts.organizationId, slug } })) > 0) {
    throw new WorkspaceImportError(`A workspace with the slug "${slug}" already exists in this organization`)
  }

  const slugWarnings = requestedReserved
    ? [`The URL slug "${requestedReserved}" is reserved by Compass, so the workspace uses "${slug}" instead.`]
    : []

  // ---- row transform -----------------------------------------------------------------------------------------------------
  let referencesCleared = 0
  const warnings = [...manifest.warnings, ...slugWarnings]
  const uploaded: { store: "artifact" | "research" | "feedback"; key: string }[] = []

  const dropped: Record<string, number> = {}
  /** Returns null when a required reference cannot be resolved (it would point outside the workspace or into another org). */
  const transform = (model: string, raw: Row): Row | null => {
    const row = decodeRow(model, raw)
    let unresolvable = false
    for (const [name, value] of Object.entries(row)) {
      const info = fieldInfo(model, name)
      if (!info) continue
      if (info.type === "Json") {
        row[name] = value === null ? undefined : rewriteDeep(value)
      } else if (info.type === "String" && typeof value === "string") {
        if (name !== "id" && UUID_EXACT.test(value)) {
          const mapped = mapUuid(value)
          if (mapped !== undefined) row[name] = mapped
          else if (!KEEP_COLUMNS.has(name)) {
            if (OPTIONAL_STRING_FIELDS[model]?.includes(name)) {
              row[name] = null
              referencesCleared++
            } else if (DROP_ON_UNRESOLVED.has(`${model}.${name}`)) {
              unresolvable = true
            }
          }
        } else if (name === "id" && UUID_EXACT.test(value)) {
          row[name] = mapUuid(value) ?? value
        } else if (REKEY_COLUMNS.has(`${model}.${name}`)) {
          row[name] = createHash("sha256").update(`${importKey}:${model}.${name}:${value}`).digest("hex")
        } else {
          row[name] = rewriteText(value)
        }
      }
    }
    if (unresolvable) {
      dropped[model] = (dropped[model] ?? 0) + 1
      return null
    }
    for (const col of SECRET_COLUMNS[model] ?? []) if (col in row) row[col] = null
    Object.assign(row, IMPORT_OVERRIDES[model] ?? {})
    // Org-scoped columns (Workspace, SavedView) always belong to the target organization, never the source.
    if ("organizationId" in row) row.organizationId = opts.organizationId
    return row
  }

  const rewritePath = rewriteText

  try {
    // ---- blobs first: a failure here writes nothing to the database ------------------------------------------------------
    let blobsCopied = 0
    for (const b of manifest.blobs) {
      if (b.store === "feedback") continue // uploaded per attachment row below
      const data = reader.read(blobEntry(b.store, b.key))
      if (!data) {
        warnings.push(`Bundle is missing blob ${b.store}/${b.key}`)
        continue
      }
      const target = rewritePath(b.key)
      const storage = b.store === "research" ? opts.blobs.research : opts.blobs.artifact
      await storage.put(target, data, b.contentType)
      uploaded.push({ store: b.store, key: target })
      blobsCopied++
    }

    // ---- rows ------------------------------------------------------------------------------------------------------------------
    const counts: Record<string, number> = {}
    for (const model of exportOrder()) {
      const delegate = delegateFor(client, model)
      let buffer: Row[] = []
      const insertedIds: string[] = []
      let total = 0
      const flush = async () => {
        if (!buffer.length) return
        const data = buffer
        buffer = []
        await withRetry(() => delegate.createMany({ data, skipDuplicates: true }))
      }
      for (const raw of reader.rows(model)) {
        const row = transform(model, raw)
        if (!row) continue
        if (model === "FeedbackAttachment" && typeof raw.id === "string") {
          const data = reader.read(blobEntry("feedback", raw.id))
          if (data) {
            const filename = String(raw.filename ?? "attachment").replace(/[^A-Za-z0-9._-]/g, "_")
            const key = `feedback/${newWorkspaceId}/${deriveId(importKey, `fb:${raw.id}`)}-${filename}`
            row.url = await opts.blobs.putPublic(key, data, String(raw.fileType ?? "application/octet-stream"))
            uploaded.push({ store: "feedback", key: row.url as string })
            blobsCopied++
          } else {
            warnings.push(`Feedback attachment ${raw.id} bytes were not in the bundle; its original URL was kept`)
          }
        }
        buffer.push(row)
        if (typeof row.id === "string") insertedIds.push(row.id)
        total++
        if (buffer.length >= CHUNK) await flush()
      }
      await flush()
      // createMany(skipDuplicates) swallows unique-constraint conflicts. Prove every row actually landed.
      for (const group of chunks(insertedIds, 500)) {
        const present = await delegate.count({ where: { id: { in: group } } })
        if (present !== group.length) {
          throw new WorkspaceImportError(`Import of ${model} was incomplete: ${group.length - present} row(s) were rejected by a uniqueness constraint`)
        }
      }
      counts[model] = total
    }

    // ---- sequence counters: never behind the highest imported number ----------------------------------------------------------
    for (const type of WORK_ITEM_TYPES) {
      const table = WORK_ITEM_REGISTRY[type].table
      const model = [...dmmfModels.values()].find((m) => m.dbName === table)?.name
      if (!model || !exportOrder().includes(model)) continue
      const agg = (await (delegateFor(client, model) as unknown as {
        aggregate(a: Row): Promise<{ _max: { seqNumber: number | null } }>
      }).aggregate({ where: { workspaceId: newWorkspaceId }, _max: { seqNumber: true } }))._max.seqNumber
      if (agg == null) continue
      const seq = delegateFor(client, "WorkspaceSequence") as unknown as {
        updateMany(a: Row): Promise<{ count: number }>
        createMany(a: Row): Promise<{ count: number }>
      }
      const bumped = await seq.updateMany({
        where: { workspaceId: newWorkspaceId, entityType: type, nextValue: { lt: agg + 1 } },
        data: { nextValue: agg + 1 },
      })
      if (bumped.count === 0) {
        await seq.createMany({ data: [{ workspaceId: newWorkspaceId, entityType: type, nextValue: agg + 1 }], skipDuplicates: true })
      }
    }

    // ---- validate before the workspace becomes visible ---------------------------------------------------------------------
    for (const model of exportOrder()) {
      if (!modelHasWorkspaceId(model) || model === "Agent" || !modelHasId(model)) continue
      const expected = (manifest.counts[model] ?? 0) - (dropped[model] ?? 0)
      const actual = await delegateFor(client, model).count({ where: { workspaceId: newWorkspaceId } })
      if (actual !== expected) throw new WorkspaceImportError(`Validation failed for ${model}: expected ${expected} rows, found ${actual}`)
    }

    // ---- commit point: the Workspace row (and its members) --------------------------------------------------------------------
    const wsRaw = reader.rows("Workspace").next().value as Row | undefined
    if (!wsRaw) throw new WorkspaceImportError("Bundle has no Workspace row")
    const wsRow = transform("Workspace", wsRaw)!
    Object.assign(wsRow, { id: newWorkspaceId, organizationId: opts.organizationId, name: baseName, slug })
    const memberRows = members.map((m) => ({ workspaceId: newWorkspaceId, userId: m.userId, role: normalizeWorkspaceRole(m.role) }))
    if (!memberRows.some((m) => m.userId === opts.importerUserId)) {
      memberRows.push({ workspaceId: newWorkspaceId, userId: opts.importerUserId, role: "ADMIN" })
    } else {
      memberRows.find((m) => m.userId === opts.importerUserId)!.role = "ADMIN"
    }
    await withRetry(() =>
      (client as { $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> }).$transaction(async (tx) => {
        await delegateFor(tx, "Workspace").createMany({ data: [wsRow] })
        await delegateFor(tx, "WorkspaceMember").createMany({ data: memberRows, skipDuplicates: true })
      }),
    )

    for (const [m, n] of Object.entries(dropped)) {
      warnings.push(`Skipped ${n} ${m} row(s) whose required reference does not exist in the target organization`)
    }
    return {
      workspaceId: newWorkspaceId,
      slug,
      name: baseName,
      alreadyImported: false,
      counts,
      usersMatched,
      usersFallbackToImporter: usersFallback,
      referencesCleared,
      blobsCopied,
      warnings,
    }
  } catch (error) {
    // The Workspace row is the commit point. If it exists, a request with the same nonce finished first (two concurrent
    // submissions derive identical ids, and the loser fails at the Workspace insert). Rolling back would delete the
    // winner's rows, so treat it as "already imported" and leave everything alone.
    const committed = await delegateFor(client, "Workspace").findMany({ where: { id: newWorkspaceId }, take: 1 }).catch(() => [])
    if (committed[0]) {
      if ((error as { code?: string }).code === "P2002") return alreadyImportedReport(committed[0], manifest)
      throw error
    }
    await rollbackImport(client, reader, importKey, newWorkspaceId, uploaded, opts.blobs).catch((rollbackError) => {
      console.error("[workspace-import] rollback failed; partial rows may remain for workspace", newWorkspaceId, rollbackError)
    })
    throw error
  }
}

/**
 * Deletes rows by id. Self-referencing models (comment replies, doc trees, subtasks) trip Prisma's emulated Restrict when a
 * parent and its children go in one statement, so on P2014 fall back to repeated passes, one row at a time, until every row
 * whose children are gone has been removed.
 */
async function deleteIdsLeafFirst(delegate: ReturnType<typeof delegateFor>, ids: string[]) {
  try {
    await withRetry(() => delegate.deleteMany({ where: { id: { in: ids } } }))
    return
  } catch (error) {
    if ((error as { code?: string }).code !== "P2014") throw error
  }
  let pending = ids
  while (pending.length) {
    const next: string[] = []
    for (const id of pending) {
      try {
        await withRetry(() => delegate.deleteMany({ where: { id } }))
      } catch (error) {
        if ((error as { code?: string }).code !== "P2014") throw error
        next.push(id)
      }
    }
    if (next.length === pending.length) throw new WorkspaceImportError("Could not remove partially imported rows")
    pending = next
  }
}

/** Removes everything a failed import wrote, children before parents. Idempotent. */
async function rollbackImport(
  client: Client,
  reader: BundleReader,
  importKey: string,
  newWorkspaceId: string,
  uploaded: { store: "artifact" | "research" | "feedback"; key: string }[],
  blobs: BlobAdapters,
) {
  const deleteModel = async (model: string) => {
    const delegate = delegateFor(client, model)
    if (modelHasId(model)) {
      const ids: string[] = []
      for (const row of reader.rows(model)) if (typeof row.id === "string") ids.push(deriveId(importKey, row.id))
      for (const group of chunks(ids, 500)) await deleteIdsLeafFirst(delegate, group)
    } else if (modelHasWorkspaceId(model)) {
      await withRetry(() => delegate.deleteMany({ where: { workspaceId: newWorkspaceId } }))
    } else {
      // Keyed by its parent (e.g. SolutionPlanProposal.commentId): delete by the derived parent ids.
      const parent = PARENT[model]
      if (!parent) return
      const parentIds: string[] = []
      for (const row of reader.rows(parent.model)) if (typeof row.id === "string") parentIds.push(deriveId(importKey, row.id))
      for (const group of chunks(parentIds, 500)) await withRetry(() => delegate.deleteMany({ where: { [parent.fk]: { in: group } } }))
    }
  }
  // Prisma emulates required relations (relationMode "prisma"), so a delete can be refused while another model
  // still points at the row (P2014). Repeat passes until everything is gone or no pass makes progress.
  let pending = [...exportOrder()].reverse()
  let lastError: unknown
  while (pending.length) {
    const next: string[] = []
    for (const model of pending) {
      try {
        await deleteModel(model)
      } catch (error) {
        if ((error as { code?: string }).code !== "P2014") throw error
        lastError = error
        next.push(model)
      }
    }
    if (next.length === pending.length) throw lastError
    pending = next
  }
  for (const u of uploaded) {
    if (u.store === "feedback") await blobs.delPublic(u.key)
    else await (u.store === "research" ? blobs.research : blobs.artifact).del(u.key).catch(() => undefined)
  }
}

