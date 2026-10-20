/**
 * The single read/write module for the generic `entity_links` table (ADR "One generic entity_links
 * table for association links", section 5). ONLY this directory may name the EntityLink model or the
 * table; a guard test (__tests__/links/entity-links-guard.test.ts) pins that. Everything else goes
 * through the functions below, so the invariants live in one reviewed place. They are the same ones
 * lib/typed-links.ts keeps for the legacy pair tables:
 *
 *  - TENANT SAFETY. A link's `workspaceId` is copied from the verified `from` row, never from an input.
 *    `expectedWorkspaceId` is a PRECONDITION: both endpoints are re-verified inside the same
 *    transaction with a workspace filter (lib/links/endpoints.ts), so a caller who can reach two
 *    workspaces still cannot join them, and a row with a NULL workspace fails closed.
 *  - READS FILTER BOTH ENDPOINTS BY WORKSPACE. `link.workspaceId` alone is never trusted: a link is
 *    returned only when both of its endpoints are themselves in the requested workspace, so a dangling
 *    or drifted endpoint is dropped, never shown.
 *  - NO ON CONFLICT. It is unproven against DSQL's async unique index. Writes are read-then-write
 *    inside a transaction; a lost race on idx_entity_links_pair surfaces as P2002 (or an OCC conflict)
 *    and runTypedLinkTransaction re-runs the whole transaction up to 3 times, after which the repeat
 *    read sees the winner and the call is an idempotent no-op.
 *  - TO-ONE CARDINALITY is enforced here, not by the database (no partial unique index on DSQL), and
 *    the entity row is touched so concurrent writers conflict.
 *  - updatedAt is set explicitly (DSQL has no trigger).
 */
import type { AppTransactionClient } from "@/lib/db"
import { normalizeEntityType, type LinkableEntityType } from "@/lib/entity-types"
import { resolveEndpoints, touchEndpoint } from "@/lib/links/endpoints"
import {
  getLinkType,
  isLinkTypeEnabled,
  linkTypesForEntity,
  requireLinkType,
  toTypesOf,
  type LinkEndpoint,
  type LinkOrigin,
  type LinkTypeDef,
} from "@/lib/links/registry"
import {
  LINK_WRITE_CHUNK,
  TypedLinkError,
  assertSameWorkspacePair,
  chunk,
  decodeCursor,
  drainByIds,
  encodeCursor,
  type LinkContext,
} from "@/lib/typed-links"

type Tx = AppTransactionClient

export { LINK_WRITE_CHUNK }

export type EntityLinkRow = {
  id: string
  workspaceId: string
  linkType: string
  fromType: string
  fromId: string
  toType: string
  toId: string
  origin: string
  source: string
  createdById: string | null
  attrs: string | null
  createdAt: Date
}

const FEATURE_OFF = "This link type cannot be used: it is not enabled for this deployment."

/** A legacy-mirrored type is written only by its legacy writer (lib/links/legacy-mirror.ts), which passes viaLegacyWriter. */
function assertWritableHere(def: LinkTypeDef, viaLegacyWriter: boolean | undefined) {
  if (def.legacy && !viaLegacyWriter) {
    const tool = def.compat?.mcpTools[0]
    throw new TypedLinkError(`${def.key} is written through ${tool ?? "its existing link tool"}, not the generic link tools.`, "INVALID")
  }
}

function assertEnabled(def: LinkTypeDef) {
  if (!isLinkTypeEnabled(def)) throw new TypedLinkError(FEATURE_OFF, "INVALID")
}

function typeLabel(type: LinkableEntityType): string {
  const words = type.toLowerCase().split("_")
  return `${words[0].charAt(0).toUpperCase()}${words[0].slice(1)}${words.length > 1 ? ` ${words.slice(1).join(" ")}` : ""}`
}

async function requireEndpoint(tx: Tx, type: LinkableEntityType, workspaceId: string, id: string): Promise<LinkEndpoint> {
  const endpoint = (await resolveEndpoints(tx, type, workspaceId, [id])).get(id)
  // One message for "missing", "foreign workspace" and "NULL workspace": it never confirms that a foreign row exists.
  if (!endpoint) throw new TypedLinkError(`${typeLabel(type)} not found in this workspace.`)
  return endpoint
}

function resolveToType(def: LinkTypeDef, requested: string | undefined): LinkableEntityType {
  const allowed = toTypesOf(def)
  if (requested === undefined) {
    if (allowed.length === 1) return allowed[0]
    throw new TypedLinkError(`toType is required for ${def.key}; one of ${allowed.join(", ")}.`, "INVALID")
  }
  const normalized = normalizeEntityType(requested)
  if (!normalized || !allowed.includes(normalized)) throw new TypedLinkError(`${def.key} links to ${allowed.join(", ")}, not ${requested}.`, "INVALID")
  return normalized
}

function serializeAttrs(def: LinkTypeDef, attrs: unknown): string | null {
  if (attrs === undefined || attrs === null) return null
  if (!def.attrs) throw new TypedLinkError(`${def.key} does not take attrs.`, "INVALID")
  const parsed = def.attrs.safeParse(attrs)
  if (!parsed.success) throw new TypedLinkError(`Invalid attrs for ${def.key}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`, "INVALID")
  return JSON.stringify(parsed.data)
}

// ── Writes ──────────────────────────────────────────────────────────────────

export type LinkEntitiesInput = {
  linkType: string
  fromId: string
  toId: string
  /** Required only when the type allows several `to` types. */
  toType?: string
  /** A precondition both endpoints must satisfy. It is never stored: the stored workspace is the `from` row's. */
  expectedWorkspaceId: string
  attrs?: unknown
  origin?: LinkOrigin
  ctx: LinkContext
  /** Set only by lib/links/legacy-mirror.ts, the single writer of a legacy-mirrored type. */
  viaLegacyWriter?: boolean
  /** With viaLegacyWriter only: an existing row takes `origin` (and, when it becomes DIRECT, this call's source and actor), because the legacy row is the truth. */
  reconcileOrigin?: boolean
}

export type LinkEntitiesResult = { link: EntityLinkRow; created: boolean; from: LinkEndpoint; to: LinkEndpoint; def: LinkTypeDef }

/**
 * Creates the link, or reconciles the existing one, without ON CONFLICT. Run it through
 * runTypedLinkTransaction (or any transaction): a lost pair race is retried there.
 */
export async function linkEntities(tx: Tx, input: LinkEntitiesInput): Promise<LinkEntitiesResult> {
  const def = requireLinkType(input.linkType)
  assertWritableHere(def, input.viaLegacyWriter)
  assertEnabled(def)
  const origin = input.origin ?? "DIRECT"
  if (def.origins && !def.origins.includes(origin)) throw new TypedLinkError(`${def.key} does not allow origin ${origin}.`, "INVALID")
  const toType = resolveToType(def, input.toType)
  const attrs = serializeAttrs(def, input.attrs)

  const fromEndpoint = await requireEndpoint(tx, def.from, input.expectedWorkspaceId, input.fromId)
  const toEndpoint = await requireEndpoint(tx, toType, input.expectedWorkspaceId, input.toId)
  const workspaceId = assertSameWorkspacePair(fromEndpoint, toEndpoint)
  if (def.direction === "symmetric" && fromEndpoint.id === toEndpoint.id && fromEndpoint.type === toEndpoint.type) {
    throw new TypedLinkError("An entity cannot be linked to itself.", "INVALID")
  }

  // Symmetric types store ONE row with endpoints ordered by (type, id), so A-B and B-A are the same link.
  const swap = def.direction === "symmetric" && `${fromEndpoint.type}:${fromEndpoint.id}` > `${toEndpoint.type}:${toEndpoint.id}`
  const [first, second] = swap ? [toEndpoint, fromEndpoint] : [fromEndpoint, toEndpoint]

  await def.eligible?.({ tx, workspaceId, from: fromEndpoint, to: toEndpoint, ctx: input.ctx })

  const existing = (await tx.entityLink.findFirst({ where: { fromId: first.id, linkType: def.key, toId: second.id } })) as EntityLinkRow | null
  if (existing) {
    if (def.duplicatePolicy === "error") throw new TypedLinkError(`Already linked (${def.key}).`, "INVALID")
    const originDrift = Boolean(input.viaLegacyWriter && input.reconcileOrigin && existing.origin !== origin)
    if (existing.workspaceId === workspaceId && !originDrift) return { link: existing, created: false, from: fromEndpoint, to: toEndpoint, def }
    // A drifted workspaceId is repaired to the verified one: both endpoints were just checked there.
    const link = (await tx.entityLink.update({
      where: { id: existing.id },
      data: {
        workspaceId,
        updatedAt: new Date(),
        ...(originDrift ? { origin, ...(origin === "DIRECT" ? { source: input.ctx.source, createdById: input.ctx.createdById ?? null } : {}) } : {}),
      },
    })) as EntityLinkRow
    return { link, created: false, from: fromEndpoint, to: toEndpoint, def }
  }

  await enforceCardinality(tx, def, workspaceId, first, second)

  const now = new Date()
  const link = (await tx.entityLink.create({
    data: {
      workspaceId,
      linkType: def.key,
      fromType: first.type,
      fromId: first.id,
      toType: second.type,
      toId: second.id,
      origin,
      source: input.ctx.source,
      createdById: input.ctx.createdById ?? null,
      attrs,
      createdAt: now,
      updatedAt: now,
    },
  })) as EntityLinkRow
  return { link, created: true, from: fromEndpoint, to: toEndpoint, def }
}

async function enforceCardinality(tx: Tx, def: LinkTypeDef, workspaceId: string, from: LinkEndpoint, to: LinkEndpoint) {
  const sides = [
    { limit: def.cardinality.from, endpoint: from, column: "fromId" as const },
    { limit: def.cardinality.to, endpoint: to, column: "toId" as const },
  ]
  for (const side of sides) {
    if (side.limit !== "one") continue
    // Touch first so the read below is part of the write set (see touchEndpoint).
    if (!(await touchEndpoint(tx, side.endpoint.type, workspaceId, side.endpoint.id))) {
      throw new Error(`${def.key}: cannot enforce to-one cardinality on ${side.endpoint.type}, which has no updatedAt to touch.`)
    }
    const others = await tx.entityLink.count({ where: { linkType: def.key, [side.column]: side.endpoint.id } })
    if (others > 0) {
      throw new TypedLinkError(`${typeLabel(side.endpoint.type)} already has a ${def.key} link; unlink it first.`, "INVALID")
    }
  }
}

export type UnlinkEntitiesInput = { linkType: string; fromId: string; toId: string; expectedWorkspaceId: string; viaLegacyWriter?: boolean }

/**
 * Removes the link (a hard delete; the audit trail is the workspace update capture). Only the `from`
 * endpoint is verified: a link whose far end has since vanished must stay removable. The delete itself is
 * scoped to the verified workspace, so it can never remove another tenant's row. `removed: 0` is success.
 */
export async function unlinkEntities(tx: Tx, input: UnlinkEntitiesInput): Promise<{ removed: number; removedIds: string[]; def: LinkTypeDef }> {
  const def = requireLinkType(input.linkType)
  assertWritableHere(def, input.viaLegacyWriter)
  // A mirror row must stay removable after the flag is turned off, or the legacy unlink would strand it.
  if (!input.viaLegacyWriter) assertEnabled(def)
  const from = await requireEndpoint(tx, def.from, input.expectedWorkspaceId, input.fromId)
  const pair = { linkType: def.key, workspaceId: from.workspaceId }
  const where =
    def.direction === "symmetric"
      ? { ...pair, OR: [{ fromId: input.fromId, toId: input.toId }, { fromId: input.toId, toId: input.fromId }] }
      : { ...pair, fromId: input.fromId, toId: input.toId }
  const rows = await tx.entityLink.findMany({ where, select: { id: true } })
  if (rows.length === 0) return { removed: 0, removedIds: [], def }
  const ids = rows.map((row) => row.id)
  const { count } = await tx.entityLink.deleteMany({ where: { id: { in: ids }, workspaceId: from.workspaceId } })
  return { removed: count, removedIds: ids, def }
}

/**
 * Removes the links of one type that start at `fromId`, optionally keeping the one that ends at `exceptToId` and optionally only
 * those of one origin. For the legacy writer only (a pointer that moved replaces its row; LEGACY objective links go stale when the
 * pointer does). The `from` endpoint is verified in `expectedWorkspaceId`; the delete is by `fromId` and type, so a row whose
 * workspace_id has drifted is removed too. `removed: 0` is success.
 */
export async function unlinkFromEntity(
  tx: Tx,
  input: { linkType: string; fromId: string; expectedWorkspaceId: string; exceptToId?: string; origin?: LinkOrigin },
): Promise<{ removed: number }> {
  const def = requireLinkType(input.linkType)
  assertWritableHere(def, true)
  await requireEndpoint(tx, def.from, input.expectedWorkspaceId, input.fromId)
  const { count } = await tx.entityLink.deleteMany({
    where: {
      linkType: def.key,
      fromId: input.fromId,
      ...(input.exceptToId ? { toId: { not: input.exceptToId } } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
    },
  })
  return { removed: count }
}

// ── Deletes ─────────────────────────────────────────────────────────────────

/**
 * Drains the links of one type that start at any of `fromIds` (optionally only one origin and only those that end at `toId`), in
 * committed passes of at most LINK_WRITE_CHUNK links. For the legacy writer only: the mirror counterpart of the legacy LEGACY-link
 * drain after a Key Result is deleted. Idempotent.
 */
export async function drainLinksFromEntities(
  db: Tx,
  input: { linkType: string; fromIds: readonly string[]; origin?: LinkOrigin; toId?: string },
): Promise<number> {
  const def = requireLinkType(input.linkType)
  assertWritableHere(def, true)
  let removed = 0
  for (const part of chunk([...new Set(input.fromIds)], LINK_WRITE_CHUNK)) {
    const where = { linkType: def.key, fromId: { in: part }, ...(input.origin ? { origin: input.origin } : {}), ...(input.toId ? { toId: input.toId } : {}) }
    removed += await drainByIds(
      (take) => db.entityLink.findMany({ where, select: { id: true }, take }),
      async (rowIds) => (await db.entityLink.deleteMany({ where: { id: { in: rowIds } } })).count,
    )
  }
  return removed
}

/**
 * Removes every link that names any of `ids` as an endpoint of `type`, in BOTH directions (there are no
 * foreign keys, so a deleted entity would otherwise leave dangling rows). Committed passes of at most
 * LINK_WRITE_CHUNK links each, because every link is 4 DSQL-modified rows against a 3,000-row transaction
 * cap; ids are chunked too. Idempotent. Call it with the same client that deletes the entity, after the
 * entity delete succeeds or (for a whole-workspace teardown) just before it.
 */
export async function deleteLinksForEntity(db: Tx, type: LinkableEntityType, ids: readonly string[]): Promise<number> {
  let removed = 0
  for (const part of chunk([...new Set(ids)], LINK_WRITE_CHUNK)) {
    removed += await drainByIds(
      (take) =>
        db.entityLink.findMany({
          where: { OR: [{ fromType: type, fromId: { in: part } }, { toType: type, toId: { in: part } }] },
          select: { id: true },
          take,
        }),
      async (rowIds) => (await db.entityLink.deleteMany({ where: { id: { in: rowIds } } })).count,
    )
  }
  return removed
}

/** Workspace teardown: every link stamped with this workspace, in passes of at most 500. Endpoint sweeps cover drifted rows. */
export async function deleteWorkspaceLinks(db: Tx, workspaceId: string): Promise<number> {
  return drainByIds(
    (take) => db.entityLink.findMany({ where: { workspaceId }, select: { id: true }, take }),
    async (rowIds) => (await db.entityLink.deleteMany({ where: { id: { in: rowIds } } })).count,
  )
}

// ── Reads ───────────────────────────────────────────────────────────────────

export type ListedEntityLink = {
  kind: "entity_link"
  id: string
  linkType: string
  /** Which end of the link the queried entity is. */
  side: "from" | "to"
  /** The label as read from the queried entity ("Informed by" from the experiment, "Informs" from the study). */
  label: string
  from: { type: LinkableEntityType; id: string; title: string }
  to: { type: LinkableEntityType; id: string; title: string }
  origin: string
  source: string
  createdAt: string
}

export type ListEntityLinksInput = {
  workspaceId: string
  entityType: string
  entityId: string
  /** Restrict to one registry type. Absent means every enabled type in which the entity is an endpoint. */
  linkType?: string
  limit: number
  cursor?: string
}

/**
 * Keyset-paginated links on one entity, oldest first. The entity must be in `workspaceId`; the other end is
 * resolved through a workspace-filtered read and a link whose other end is missing, NULL-workspace or
 * foreign is left out (so a page can hold fewer than `limit` rows without being the last). Types behind a
 * disabled feature flag are invisible.
 */
export async function listLinks(db: Tx, input: ListEntityLinksInput): Promise<{ items: ListedEntityLink[]; nextCursor: string | null }> {
  const entityType = normalizeEntityType(input.entityType)
  if (!entityType) throw new TypedLinkError(`Unknown entity type "${input.entityType}".`, "INVALID")
  await requireEndpoint(db, entityType, input.workspaceId, input.entityId)

  const applicable = linkTypesForEntity(entityType)
  let scoped = applicable
  if (input.linkType !== undefined) {
    const def = requireLinkType(input.linkType)
    scoped = applicable.filter((entry) => entry.def.key === def.key)
    // Disabled, or legacy-mirrored (reads stay on the legacy table): nothing to list, and not an error.
    if (scoped.length === 0 && (def.legacy || !isLinkTypeEnabled(def))) return { items: [], nextCursor: null }
    if (scoped.length === 0) throw new TypedLinkError(`${def.key} does not link ${entityType} entities.`, "INVALID")
  }
  if (scoped.length === 0) return { items: [], nextCursor: null }

  const keys = scoped.map((entry) => entry.def.key)
  const cursor = input.cursor ? decodeCursor(input.cursor) : null
  const take = Math.min(Math.max(Math.trunc(input.limit) || 1, 1), 200)
  const after = cursor ? { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] } : {}
  const ends = [
    ...(scoped.some((entry) => entry.asFrom) ? [{ fromType: entityType, fromId: input.entityId }] : []),
    ...(scoped.some((entry) => entry.asTo) ? [{ toType: entityType, toId: input.entityId }] : []),
  ]
  const rows = (await db.entityLink.findMany({
    where: { AND: [{ workspaceId: input.workspaceId, linkType: { in: keys }, OR: ends }, after] },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: take + 1,
  })) as EntityLinkRow[]
  const page = rows.slice(0, take)
  const nextCursor = rows.length > take ? encodeCursor(page[page.length - 1]) : null

  // Resolve every endpoint type in the page with one workspace-filtered read each.
  const idsByType = new Map<LinkableEntityType, string[]>()
  const remember = (type: string, id: string) => {
    const known = normalizeEntityType(type)
    if (!known) return
    idsByType.set(known, [...(idsByType.get(known) ?? []), id])
  }
  for (const row of page) {
    remember(row.fromType, row.fromId)
    remember(row.toType, row.toId)
  }
  const resolved = new Map<string, LinkEndpoint>()
  for (const [type, ids] of idsByType) {
    for (const [id, endpoint] of await resolveEndpoints(db, type, input.workspaceId, ids)) resolved.set(`${type}:${id}`, endpoint)
  }

  const items: ListedEntityLink[] = []
  for (const row of page) {
    const def = getLinkType(row.linkType)
    const from = resolved.get(`${row.fromType}:${row.fromId}`)
    const to = resolved.get(`${row.toType}:${row.toId}`)
    if (!def || !from || !to) continue
    const side = row.fromId === input.entityId && row.fromType === entityType ? "from" : "to"
    items.push({
      kind: "entity_link",
      id: row.id,
      linkType: row.linkType,
      side,
      label: side === "from" ? def.labels.forward : def.labels.inverse,
      from: { type: from.type, id: from.id, title: from.title },
      to: { type: to.type, id: to.id, title: to.title },
      origin: row.origin,
      source: row.source,
      createdAt: row.createdAt.toISOString(),
    })
  }
  return { items, nextCursor }
}
