import { configuredBlobStoreHostname } from "@/lib/feedback-attachments"
import { copyPublicImportAsset } from "./public-import-asset"
import { ImportOwnershipChanged } from "./lease"
import { externalLinkKeyHash } from "@/lib/external-link-key"
import { createHash, randomUUID } from "node:crypto"
import { normalizeWorkspaceRole } from "@/lib/roles"
import { SLUG_PATTERN, isReservedWorkspaceSlug } from "@/lib/slug"
import { WORK_ITEM_REGISTRY, WORK_ITEM_TYPES } from "@/lib/work-item-ids"
import { BundleReader, blobEntry, type BundleManifest } from "@/lib/workspace-export/bundle"
import { type BlobAdapters } from "@/lib/workspace-export/blobs"
import { decodeRow, fieldInfo } from "@/lib/workspace-export/codec"
import { OPTIONAL_FIELDS, OPTIONAL_STRING_FIELDS, UNIQUE_KEYS } from "@/lib/workspace-export/schema-meta.generated"
import { deleteIdsLeafFirst, deleteScopedImportRows, withRetry } from "@/lib/workspace-export/leaf-first"
import { IMPORT_OVERRIDES, SECRET_COLUMNS } from "@/lib/workspace-export/model-registry"
import {
  capabilityPackArtifactPath,
  confineStoragePath,
  isOwnFeedbackAttachmentUrl,
  type PrivateBlobStore,
} from "@/lib/workspace-export/path-confinement"
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
 * Required id columns are an ALLOW-LIST: a value that does not resolve to a row in the bundle (or to a user / a verified
 * target-org scoring model) drops the whole row. Nothing unresolved is ever left pointing at another workspace or org.
 * Author-style user columns are the one exception: they fall back to the importer, like every other unmatched user.
 */
const AUTHOR_FALLBACK_COLUMNS = new Set(["createdById", "updatedById", "actorUserId", "initiatingUserId", "ownerId", "ownerUserId"])
/** Id-named columns that hold free text (not UUIDs), so a 32-hex value in them is left alone. */
const TEXT_ID_COLUMNS = new Set(["CapabilityPack.packId", "AnalyticsConnection.projectId", "WorkspaceCapabilityPack.enabledSkillIds"])
/** Overwritten with the target after the row is built, so the bundle's value is irrelevant (never a reason to drop). */
const FORCED_COLUMNS = new Set(["organizationId", "workspaceId"])
/**
 * Columns holding a private-store path. The value must be confined to the source workspace's own prefix and is
 * rewritten into the new workspace's prefix. `drop` removes the row when invalid, `null` clears the column.
 */
const PATH_COLUMNS: Readonly<Record<string, { store: PrivateBlobStore | "pack"; invalid: "drop" | "null" }>> = {
  "ArtifactRevision.blobPathname": { store: "artifact", invalid: "drop" },
  "ArtifactRevision.thumbnailPathname": { store: "artifact", invalid: "null" },
  "ResearchAttachment.blobPathname": { store: "research", invalid: "drop" },
  "CapabilityPackVersion.artifactPathname": { store: "pack", invalid: "drop" },
}
/** Geode-hosted documents are refused on export; a bundle claiming one must not point at someone else's Geode object. */
const CLEARED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  Doc: ["contentRef", "storageProvider"],
  DocVersion: ["contentRef", "storageProvider"],
}
/**
 * Content columns that are unique across the WHOLE database (not per workspace) and so would collide with the
 * source rows. They are rewritten to a per-import hash; the value is only ever compared for equality.
 */
const REKEY_COLUMNS = new Set(["DecisionRecord.idempotencyKey", "DecisionApplication.receiptKey", "MetricObservation.refreshKey"])
const MAX_ROWS_PER_MODEL = 2_000_000

export class WorkspaceImportError extends Error {}
export class WorkspaceImportRecoveryRequired extends Error {}

export type ImportOptions = {
  organizationId: string
  importerUserId: string
  name?: string
  slug?: string
  /** Retrying with the same nonce resumes the same import; a new nonce makes a fresh copy. */
  nonce?: string
  rollbackComplete?(): Promise<void>
  fenceWrite?(tx: unknown, phase: "applying" | "rolling_back" | "recovering"): Promise<void>
  providerIO?<T>(io: () => Promise<T>): Promise<T>
  journal?: {
    reserve(store: PrivateBlobStore | "feedback", logical: string, bytes: Uint8Array): Promise<string>
    verify(store: PrivateBlobStore | "feedback", logical: string, physical: string): Promise<void>
  }
  startOperation?(workspaceId: string, bundleDigest: string): Promise<void | "applying" | "recovering">
  resumeRecovered?(): Promise<void>
  recordExisting?(report: ImportReport): Promise<void>
  bindWorkspace?(workspaceId: string): Promise<void>
  publishResult?(tx: unknown, report: ImportReport): Promise<void>
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

/**
 * Canonical lower-case hyphenated form of a UUID written in any spelling Postgres accepts (braces, `urn:uuid:`,
 * no hyphens, upper case), or null when the value is not a UUID. Every id comparison goes through this so a
 * non-canonical spelling cannot slip past the allow-list and still be read by the database as a foreign id.
 */
export function canonUuid(value: string): string | null {
  const hex = value.trim().replace(/^urn:uuid:/i, "").replace(/^\{(.*)\}$/, "$1").replace(/-/g, "")
  if (!/^[0-9a-f]{32}$/i.test(hex)) return null
  const h = hex.toLowerCase()
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

function deriveId(importKey: string, oldId: string): string {
  const h = createHash("sha256").update(`${importKey}:${(canonUuid(oldId) ?? oldId).toLowerCase()}`).digest("hex")
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** Serializes a unique-key tuple when all columns are non-null, or null when any part is NULL/omitted (NULLs are distinct in Postgres). */
function uniqueTupleKey(row: Row, cols: readonly string[]): string | null {
  const parts: unknown[] = []
  for (const col of cols) {
    const v = row[col]
    if (v === null || v === undefined) return null
    if (typeof v === "string") parts.push(UUID_EXACT.test(v) ? v.toLowerCase() : v)
    else if (v instanceof Date) parts.push({ $d: v.toISOString() })
    else if (typeof v === "bigint") parts.push({ $b: v.toString() })
    else if (v instanceof Uint8Array) parts.push({ $y: Buffer.from(v).toString("base64") })
    else parts.push(v)
  }
  return JSON.stringify(parts)
}

const BUNDLE_DATA_ENTRY = /^data\/([A-Za-z]+)\.\d{4}\.ndjson$/

/**
 * Models and columns that older bundles carry but no longer exist: the legacy link tables were dropped (their links live in EntityLink,
 * which every bundle carries) and so was opportunities.linked_key_result_id. Such an entry is skipped with a warning instead of making an
 * old bundle unimportable; it never reaches the database.
 */
export const RETIRED_BUNDLE_MODELS: ReadonlySet<string> = new Set(["TaskLink", "ArtifactLink", "OpportunityObjectiveLink", "SolutionKeyResultLink"])
export const RETIRED_BUNDLE_COLUMNS: Readonly<Record<string, readonly string[]>> = { Opportunity: ["linkedKeyResultId"] }

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
  const retiredSeen = new Set<string>()
  for (const name of reader.list("data/")) {
    const m = BUNDLE_DATA_ENTRY.exec(name)
    if (m && RETIRED_BUNDLE_MODELS.has(m[1])) {
      retiredSeen.add(m[1])
      continue
    }
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
      if (typeof row.id === "string") idSet.add((canonUuid(row.id) ?? row.id).toLowerCase())
    }
  }
  const newWorkspaceId = deriveId(importKey, manifest.source.workspaceId)

  await opts.bindWorkspace?.(newWorkspaceId)
  const existing = await delegateFor(client, "Workspace").findMany({ where: { id: newWorkspaceId }, take: 1 })
  if (existing[0]) {
    const report = alreadyImportedReport(existing[0], manifest)
    await opts.recordExisting?.(report)
    return report
  }

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
  const matchedUsers = new Set<string>()
  let usersMatched = 0
  let usersFallback = 0
  for (const u of manifest.users) {
    if (userMap.has(u.id.toLowerCase())) throw new WorkspaceImportError("A voter or user identity in this bundle could not be matched uniquely. Resolve duplicate identities before importing.")
    const target = byEmail.get(u.email.toLowerCase())
    if (target) { usersMatched++; matchedUsers.add(u.id.toLowerCase()) }
    else usersFallback++
    userMap.set(u.id.toLowerCase(), target ?? opts.importerUserId)
  }
  const voteIdentities = new Map<string, string>()
  for (const vote of reader.rows("DecisionVote")) {
    const source = typeof vote.voterUserId === "string" ? vote.voterUserId.toLowerCase() : ""
    const target = userMap.get(source)
    if (!matchedUsers.has(source) || !target || idSet.has(source) || (voteIdentities.has(target) && voteIdentities.get(target) !== source)) {
      throw new WorkspaceImportError("A voter in this bundle could not be matched to a member of the target organization. Match all voters before importing.")
    }
    voteIdentities.set(target, source)
  }
  // The manifest is attacker-written, so a scoring model is only kept when it really belongs to the target organization.
  const claimedModels = manifest.scoringModels.filter((s) => s.organizationId === opts.organizationId).map((s) => s.id)
  const verifiedModels = claimedModels.length
    ? ((await delegateFor(client, "ScoringModel").findMany({
        where: { id: { in: claimedModels }, organizationId: opts.organizationId },
        select: { id: true },
      })) as { id: string }[])
    : []
  const keep = new Set(verifiedModels.map((m) => m.id.toLowerCase()))

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
  if (retiredSeen.size > 0) warnings.push(`Ignored retired legacy link data in the bundle (${[...retiredSeen].sort().join(", ")}); links are restored from the bundle's EntityLink rows.`)
  /** Only objects THIS import created. Rollback deletes exactly these, never a pre-existing object. */
  const uploaded: { store: "artifact" | "research" | "feedback"; key: string }[] = []
  const sourceWorkspaceId = manifest.source.workspaceId

  const dropped: Record<string, number> = {}
  const deduped: Record<string, number> = {}
  const droppedIds = new Set<string>()
  const dedupedIds = new Set<string>()
  /** Returns null when a required reference cannot be resolved (it would point outside the workspace or into another org). */
  const transform = (model: string, raw: Row): Row | null => {
    const row = decodeRow(model, raw)
    for (const column of RETIRED_BUNDLE_COLUMNS[model] ?? []) delete row[column]
    let unresolvable = false
    for (const [name, value] of Object.entries(row)) {
      const info = fieldInfo(model, name)
      if (!info) continue
      if (FORCED_COLUMNS.has(name)) continue
      // These identities belong to external providers, even when a URL happens to contain one of our UUIDs.
      if (model === "ExternalLink" && ["url", "externalKey", "provider"].includes(name)) continue
      // Real databases hold legacy NULLs in columns the schema now declares required (they have a default).
      // Prisma rejects an explicit null there, so leave the key out and let the column default apply.
      if (value === null && !OPTIONAL_FIELDS[model]?.includes(name)) {
        delete row[name]
        continue
      }
      const pathRule = PATH_COLUMNS[`${model}.${name}`]
      if (pathRule && typeof value === "string") {
        const confined =
          pathRule.store === "pack"
            ? capabilityPackArtifactPath(value, row.artifactSha256)
            : confineStoragePath(pathRule.store, value, sourceWorkspaceId, newWorkspaceId, rewriteText)
        if (confined) row[name] = confined
        else if (pathRule.invalid === "null") {
          row[name] = null
          referencesCleared++
        } else unresolvable = true
        continue
      }
      if (info.type === "Json") {
        row[name] = value === null ? undefined : rewriteDeep(value)
      } else if (info.type === "String" && typeof value === "string") {
        // Id columns accept any UUID spelling Postgres does; canonicalise so the allow-list sees what the database will.
        const asUuid = UUID_EXACT.test(value)
          ? value
          : (name === "id" || /Id$/.test(name)) && !TEXT_ID_COLUMNS.has(`${model}.${name}`)
            ? canonUuid(value)
            : null
        if (name !== "id" && asUuid) {
          const mapped = mapUuid(asUuid)
          if (mapped !== undefined) row[name] = mapped
          else if (model === "ReviewRequest" && name === "subjectId" && row.subjectType === "TRACKED_DECISION") {
            // A tracked decision's subjectId is an identity/idempotency key (lib/tracked-decisions.ts), not a row id, so it
            // never resolves inside the bundle. Re-derive it per import: it points at nothing, and stays unique.
            row[name] = deriveId(importKey, asUuid)
          } else if (!KEEP_COLUMNS.has(name)) {
            if (OPTIONAL_STRING_FIELDS[model]?.includes(name)) {
              row[name] = null
              referencesCleared++
            } else if (AUTHOR_FALLBACK_COLUMNS.has(name)) {
              row[name] = opts.importerUserId
              referencesCleared++
            } else {
              unresolvable = true
            }
          }
        } else if (name === "id" && asUuid) {
          row[name] = mapUuid(asUuid) ?? asUuid
        } else if (REKEY_COLUMNS.has(`${model}.${name}`)) {
          row[name] = createHash("sha256").update(`${importKey}:${model}.${name}:${value}`).digest("hex")
        } else {
          row[name] = rewriteText(value)
        }
      }
    }
    if (unresolvable) {
      dropped[model] = (dropped[model] ?? 0) + 1
      if (typeof row.id === "string") droppedIds.add(row.id.toLowerCase())
      return null
    }
    for (const col of SECRET_COLUMNS[model] ?? []) if (col in row) row[col] = null
    Object.assign(row, IMPORT_OVERRIDES[model] ?? {})
    // Org-scoped columns (Workspace, SavedView) always belong to the target organization, never the source.
    if ("organizationId" in row) row.organizationId = opts.organizationId
    // Tenant isolation: every row of a workspace-scoped model belongs to the NEW workspace, whatever the bundle says.
    if (modelHasWorkspaceId(model)) row.workspaceId = newWorkspaceId
    if (model === "Agent" && row.ownerWorkspaceId) row.ownerWorkspaceId = newWorkspaceId
    for (const col of CLEARED_COLUMNS[model] ?? []) if (col in row) row[col] = null
    if (model === "ExternalLink") {
      if (typeof row.externalKey !== "string") throw new WorkspaceImportError("ExternalLink is missing its external key")
      // Old bundles have no digest, and supplied digests are untrusted. Derive it after all identity rewrites.
      row.externalKeyHash = externalLinkKeyHash(row.externalKey)
    }
    return row
  }

  const phase = await opts.startOperation?.(newWorkspaceId, createHash("sha256").update(bytes).digest("hex"))
  async function write<T>(phase: "applying" | "rolling_back" | "recovering", mutation: (tx: Client) => Promise<T>) {
    const fence = opts.fenceWrite
    if (!fence) return withRetry(() => mutation(client))
    return withRetry(() => (client as { $transaction(fn: (tx: Client) => Promise<T>): Promise<T> }).$transaction(async tx => {
      await fence(tx, phase)
      return mutation(tx)
    }))
  }
  if (phase === "recovering") {
    const published = await delegateFor(client, "Workspace").findMany({ where: { id: newWorkspaceId }, take: 1 })
    if (published.length) throw new WorkspaceImportRecoveryRequired("Workspace was published during import recovery")
    await rollbackImport(client, reader, importKey, newWorkspaceId, [], opts.blobs, mutation => write("recovering", mutation))
    if (!opts.resumeRecovered) throw new WorkspaceImportRecoveryRequired("Import recovery could not be finalized")
    await opts.resumeRecovered()
  }
  const providerIO = opts.providerIO ?? (<T>(io: () => Promise<T>) => io())
  const rewritePath = rewriteText

  try {
    // ---- blobs first: a failure here writes nothing to the database ------------------------------------------------------
    let blobsCopied = 0
    for (const b of manifest.blobs) {
      if (b.store === "feedback") continue // uploaded per attachment row below
      if (b.store !== "artifact" && b.store !== "research") {
        warnings.push(`Skipped blob with unknown store ${String(b.store)}`)
        continue
      }
      const data = reader.read(blobEntry(b.store, b.key))
      if (!data) {
        warnings.push(`Bundle is missing blob ${b.store}/${b.key}`)
        continue
      }
      const target = confineStoragePath(b.store, b.key, sourceWorkspaceId, newWorkspaceId, rewritePath)
      if (!target) {
        warnings.push(`Skipped blob ${b.store}/${b.key}: it is not under the source workspace's own storage prefix`)
        continue
      }
      const storage = b.store === "research" ? opts.blobs.research : opts.blobs.artifact
      // Never overwrite: the target prefix is brand new, so an existing object is not ours to replace (or to delete later).
      const physical = opts.journal ? await opts.journal.reserve(b.store, target, data) : target
      const put = await providerIO(() => storage.put(physical, data, b.contentType, { overwrite: false }))
      if (opts.journal) {
        const bytes = await providerIO(() => storage.get(physical))
        if (put.pathname !== physical || !bytes || !Buffer.from(data).equals(bytes)) {
          throw new WorkspaceImportRecoveryRequired("Import asset verification failed")
        }
        await opts.journal.verify(b.store, target, physical)
      } else if (put.created !== false) {
        uploaded.push({ store: b.store, key: physical })
      }
      blobsCopied++
    }

    // ---- rows ------------------------------------------------------------------------------------------------------------------
    const counts: Record<string, number> = {}
    for (const model of exportOrder()) {
      const delegate = delegateFor(client, model)
      const uniqueConstraints = UNIQUE_KEYS[model] ?? []
      const seenUnique = uniqueConstraints.map(() => new Set<string>())
      const parent = PARENT[model]
      let buffer: Row[] = []
      const insertedIds: string[] = []
      const externalKeysByDigest = new Map<string, string>()
      const expectedExternalKeys = new Map<string, { externalKey: string; externalKeyHash: string }>()
      let total = 0
      const flush = async () => {
        if (!buffer.length) return
        const data = buffer
        buffer = []
        await write("applying", tx => delegateFor(tx, model).createMany({ data, skipDuplicates: true }))
      }
      for (const raw of reader.rows(model)) {
        const row = transform(model, raw)
        if (!row) continue
        if (parent && typeof row[parent.fk] === "string") {
          const parentId = (row[parent.fk] as string).toLowerCase()
          if (droppedIds.has(parentId)) {
            dropped[model] = (dropped[model] ?? 0) + 1
            if (typeof row.id === "string") droppedIds.add(row.id.toLowerCase())
            continue
          }
          if (dedupedIds.has(parentId)) {
            deduped[model] = (deduped[model] ?? 0) + 1
            if (typeof row.id === "string") dedupedIds.add(row.id.toLowerCase())
            continue
          }
        }
        if (model === "ExternalLink") {
          const digestTuple = uniqueTupleKey(row, ["subjectType", "subjectId", "provider", "externalKeyHash"])
          if (digestTuple === null || typeof row.externalKey !== "string" || typeof row.externalKeyHash !== "string") {
            throw new WorkspaceImportError("ExternalLink has an incomplete external identity")
          }
          const previous = externalKeysByDigest.get(digestTuple)
          if (previous !== undefined && previous !== row.externalKey) throw new WorkspaceImportError("ExternalLink digest collision; import was not applied")
          externalKeysByDigest.set(digestTuple, row.externalKey)
        }
        if (uniqueConstraints.length > 0) {
          const tupleKeys = uniqueConstraints.map((cols) => uniqueTupleKey(row, cols))
          if (tupleKeys.some((k, i) => k !== null && seenUnique[i].has(k))) {
            deduped[model] = (deduped[model] ?? 0) + 1
            if (typeof row.id === "string") dedupedIds.add(row.id.toLowerCase())
            continue
          }
          for (let i = 0; i < tupleKeys.length; i++) {
            if (tupleKeys[i] !== null) seenUnique[i].add(tupleKeys[i]!)
          }
        }
        if (model === "FeedbackAttachment") {
          const data = typeof raw.id === "string" ? reader.read(blobEntry("feedback", raw.id)) : null
          if (data && typeof raw.id === "string") {
            const filename = String(raw.filename ?? "attachment").replace(/[^A-Za-z0-9._-]/g, "_")
            const key = `feedback/${newWorkspaceId}/${deriveId(importKey, `fb:${raw.id}`)}-${filename}`
            const contentType = String(raw.fileType ?? "application/octet-stream")
            const journal = opts.journal
            if (journal) {
              row.url = await copyPublicImportAsset(opts.blobs, journal, key, data, contentType, configuredBlobStoreHostname(), providerIO)
            } else {
              row.url = await providerIO(() => opts.blobs.putPublic(key, data, contentType))
              uploaded.push({ store: "feedback", key: row.url as string })
            }
            blobsCopied++
          } else if (isOwnFeedbackAttachmentUrl(raw.url, sourceWorkspaceId)) {
            // Only this deployment's own public-store URLs survive, and verbatim (not run through the id rewrite).
            row.url = raw.url
            warnings.push(`Feedback attachment ${raw.id} bytes were not in the bundle; its original URL was kept`)
          } else {
            dropped.FeedbackAttachment = (dropped.FeedbackAttachment ?? 0) + 1
            warnings.push(`Feedback attachment ${raw.id} had no bytes in the bundle and an external URL; it was skipped`)
            continue
          }
        }
        if (model === "ExternalLink" && typeof row.id === "string") {
          expectedExternalKeys.set(row.id, {externalKey: row.externalKey as string, externalKeyHash: row.externalKeyHash as string})
        }
        buffer.push(row)
        if (typeof row.id === "string") insertedIds.push(row.id)
        total++
        if (buffer.length >= CHUNK) await flush()
      }
      await flush()
      // createMany(skipDuplicates) swallows unique-constraint conflicts. Prove every row actually landed.
      for (const group of chunks(insertedIds, 500)) {
        if (model === "ExternalLink") {
          // skipDuplicates must never turn a digest collision or rejected write into a successful import.
          const rows = await delegate.findMany({where: {id: {in: group}}, select: {id: true, externalKey: true, externalKeyHash: true}})
          if (rows.length !== group.length || rows.some(row => {
            const expected = expectedExternalKeys.get(String(row.id))
            return !expected || row.externalKey !== expected.externalKey || row.externalKeyHash !== expected.externalKeyHash
          })) throw new WorkspaceImportError("ExternalLink identity readback failed; import was not applied")
        }
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
      await write("applying", async tx => {
        const seq = delegateFor(tx, "WorkspaceSequence") as unknown as {
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
      })
    }

    // ---- validate before the workspace becomes visible ---------------------------------------------------------------------
    for (const model of exportOrder()) {
      if (!modelHasWorkspaceId(model) || model === "Agent" || !modelHasId(model)) continue
      const actual = await delegateFor(client, model).count({ where: { workspaceId: newWorkspaceId } })
      // The authoritative check compares with what THIS import inserted. The manifest's counts are written by whoever
      // made the bundle, so they are only a consistency check on an honest bundle, never the proof of correctness.
      const inserted = counts[model] ?? 0
      if (actual !== inserted) throw new WorkspaceImportError(`Validation failed for ${model}: expected ${inserted} rows, found ${actual}`)
      const expected = (manifest.counts[model] ?? 0) - (dropped[model] ?? 0) - (deduped[model] ?? 0)
      if (actual !== expected) throw new WorkspaceImportError(`Validation failed for ${model}: expected ${expected} rows, found ${actual}`)
    }

    // ---- commit point: the Workspace row (and its members) --------------------------------------------------------------------
    const wsRaw = reader.rows("Workspace").next().value as Row | undefined
    if (!wsRaw) throw new WorkspaceImportError("Bundle has no Workspace row")
    const wsRow = transform("Workspace", wsRaw)
    if (!wsRow) throw new WorkspaceImportError("Bundle Workspace row is invalid")
    Object.assign(wsRow, { id: newWorkspaceId, organizationId: opts.organizationId, name: baseName, slug })
    const memberRows = members.map((m) => ({ workspaceId: newWorkspaceId, userId: m.userId, role: normalizeWorkspaceRole(m.role) }))
    if (!memberRows.some((m) => m.userId === opts.importerUserId)) {
      memberRows.push({ workspaceId: newWorkspaceId, userId: opts.importerUserId, role: "ADMIN" })
    } else {
      memberRows.find((m) => m.userId === opts.importerUserId)!.role = "ADMIN"
    }
    for (const [m, n] of Object.entries(dropped)) {
      warnings.push(`Skipped ${n} ${m} row(s) whose required reference or storage path does not resolve inside the bundle`)
    }
    for (const [m, n] of Object.entries(deduped)) {
      warnings.push(`Skipped ${n} ${m} row(s) that would duplicate another row once people without an account in this organization were attributed to you`)
    }
    const report: ImportReport = {
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
    await withRetry(() =>
      (client as { $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> }).$transaction(async (tx) => {
        await opts.fenceWrite?.(tx, "applying")
        await delegateFor(tx, "Workspace").createMany({ data: [wsRow] })
        await delegateFor(tx, "WorkspaceMember").createMany({ data: memberRows, skipDuplicates: true })
        await opts.publishResult?.(tx, report)
      }),
    )
    return report
  } catch (error) {
    if (error instanceof ImportOwnershipChanged) throw error
    // The Workspace row is the commit point. If it exists, a request with the same nonce finished first (two concurrent
    // submissions derive identical ids, and the loser fails at the Workspace insert). Rolling back would delete the
    // winner's rows, so treat it as "already imported" and leave everything alone.
    const committed = await delegateFor(client, "Workspace").findMany({ where: { id: newWorkspaceId }, take: 1 }).catch((cause: unknown) => {
      throw new WorkspaceImportRecoveryRequired("Workspace import outcome is unknown and needs reconciliation", { cause })
    })
    if (committed[0]) {
      if ((error as { code?: string }).code === "P2002") {
        const report = alreadyImportedReport(committed[0], manifest)
        await opts.recordExisting?.(report)
        return report
      }
      throw error
    }
    await rollbackImport(client, reader, importKey, newWorkspaceId, uploaded, opts.blobs, mutation => write("rolling_back", mutation)).catch((rollbackError) => {
      throw new WorkspaceImportRecoveryRequired("Workspace import rollback needs reconciliation", { cause: rollbackError })
    })
    await opts.rollbackComplete?.()
    throw error
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
  write: <T>(mutation: (tx: Client) => Promise<T>) => Promise<T>,
) {
  const directScope = (model: string): Row | undefined => {
    if (model === "Agent") return { ownerType: "WORKSPACE", ownerWorkspaceId: newWorkspaceId }
    if (modelHasWorkspaceId(model)) return { workspaceId: newWorkspaceId }
  }

  // Verify each link back to the destination inside the fenced deletion transaction.
  async function ownedIds(tx: Client, model: string, candidates: string[]): Promise<string[]> {
    if (!candidates.length) return []
    const scope = directScope(model)
    const parent = PARENT[model]
    if (!scope && !parent) throw new Error("Unknown import ownership for " + model)
    const rows = await delegateFor(tx, model).findMany({
      where: { id: { in: candidates }, ...scope },
      select: scope ? { id: true } : { id: true, [parent.fk]: true },
    })
    if (scope) return rows.map(row => String(row.id))
    const parents = new Set(await ownedIds(tx, parent.model, rows.map(row => String(row[parent.fk]))))
    return rows.filter(row => parents.has(String(row[parent.fk]))).map(row => String(row.id))
  }

  const deleteModel = async (model: string) => {
    const delegate = { deleteMany: (args: { where: Row; limit?: number }) => write(async tx => {
      const scope = directScope(model)
      if (scope) return delegateFor(tx, model).deleteMany({ ...args, where: { ...args.where, ...scope } })
      const parent = PARENT[model]
      if (!parent) throw new Error("Unknown import ownership for " + model)
      const idPredicate = args.where.id
      if (idPredicate) {
        const candidates = typeof idPredicate === "string" ? [idPredicate] : (idPredicate as { in: string[] }).in
        const ids = await ownedIds(tx, model, candidates)
        return delegateFor(tx, model).deleteMany({ where: { id: { in: ids } } })
      }
      const candidates = (args.where[parent.fk] as { in: string[] }).in
      const ids = await ownedIds(tx, parent.model, candidates)
      return delegateFor(tx, model).deleteMany({ ...args, where: { [parent.fk]: { in: ids } } })
    }) }
    if (modelHasId(model)) {
      const ids: string[] = []
      for (const row of reader.rows(model)) if (typeof row.id === "string") ids.push(deriveId(importKey, row.id))
      for (const group of chunks(ids, 100)) await deleteIdsLeafFirst(delegate, group)
    } else if (modelHasWorkspaceId(model)) {
      await deleteScopedImportRows({ workspaceId: newWorkspaceId }, delegate.deleteMany)
    } else {
      // Keyed by its parent (e.g. SolutionPlanProposal.commentId): delete by the derived parent ids.
      const parent = PARENT[model]
      if (!parent) return
      const parentIds: string[] = []
      for (const row of reader.rows(parent.model)) if (typeof row.id === "string") parentIds.push(deriveId(importKey, row.id))
      for (const group of chunks(parentIds, 500)) await deleteScopedImportRows({ [parent.fk]: { in: group } }, delegate.deleteMany)
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

