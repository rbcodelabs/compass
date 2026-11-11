/**
 * The single read/write module for the association links between Opportunities, Objectives, Key Results and Solutions (ADR: typed links
 * between Opportunities, Objectives, Key Results and Solutions; "One generic entity_links table"). entity_links is the only store:
 *
 *   OPPORTUNITY_TARGETS_OBJECTIVE   Opportunity <-> Objective   (origin DIRECT | LEGACY)
 *   OPPORTUNITY_TARGETS_KEY_RESULT  Opportunity -> Key Result   (the pointer; origin LEGACY, at most one per Opportunity)
 *   SOLUTION_TARGETS_KEY_RESULT     Solution    <-> Key Result
 *
 * It is the dedicated writer of those three link types: the generic link tools refuse them (lib/links/registry.ts `dedicatedWriter`),
 * and this module passes `viaDedicatedWriter` to lib/links/service.ts. Every other file goes through the functions below, so the
 * invariants live in one reviewed place:
 *
 *  - TENANT SAFETY. A link row's `workspaceId` is ALWAYS copied from the authorized parent row (the opportunity or the solution), never
 *    from an input. Both endpoints are re-verified inside the same transaction with `findFirst({ id, workspaceId })`, so a caller that
 *    holds access to two workspaces still cannot cross-link them, and a row whose own workspaceId is NULL (an unbackfilled
 *    Solution/Objective) fails closed.
 *  - READS JOIN WORKSPACE-FILTERED ENDPOINTS. `link.workspaceId` alone is never trusted: a link is returned only when its other endpoint
 *    is itself in the requested workspace.
 *  - ORIGIN IS SINGLE-VALUED PER PAIR. A pair is either DIRECT (made through the link tools) or LEGACY (derived from the Opportunity's
 *    Key Result link). Adding a DIRECT link over an existing LEGACY pair FLIPS it to DIRECT, so clearing the Key Result can never delete
 *    a user-made link; a derived write never downgrades a DIRECT one.
 *  - NO ON CONFLICT. It is unproven against DSQL's async unique index. Writes are read-then-write inside a transaction; a lost race
 *    surfaces as P2002 (or an OCC conflict) and the whole transaction is retried a bounded number of times, after which the repeat
 *    read sees the winner and the call is an idempotent no-op.
 *
 * The Opportunity -> Key Result pointer lives ONLY in entity_links. The column opportunities.linked_key_result_id is neither read nor
 * written any more (it stays in the database until the tables are dropped).
 */
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db"
import { withAtomicRetry } from "@/lib/workspace-updates-capture"

// lib/links/service.ts imports this module (errors, chunking, cursors), so its functions are loaded lazily at call time: a static
// import would be a cycle.
const entityLinkService = () => import("@/lib/links/service")
const entityLinkReaders = () => import("@/lib/links/readers")

const OPPORTUNITY_OBJECTIVE = "OPPORTUNITY_TARGETS_OBJECTIVE"
const OPPORTUNITY_KEY_RESULT = "OPPORTUNITY_TARGETS_KEY_RESULT"
const SOLUTION_KEY_RESULT = "SOLUTION_TARGETS_KEY_RESULT"

/** "AGENT" marks a link the in-app agent made on its own (lib/agent-conversation-links.ts); the others are explicit user or API calls. */
export type LinkSource = "UI" | "MCP" | "API" | "AGENT"
export type LinkContext = { source: LinkSource; createdById?: string | null }

export type TypedLinkErrorCode = "NOT_FOUND" | "WORKSPACE_MISMATCH" | "INVALID"

/** A failure whose message is safe to show the caller as-is. It never confirms that a foreign row exists. */
export class TypedLinkError extends Error {
  constructor(
    message: string,
    readonly code: TypedLinkErrorCode = "NOT_FOUND",
  ) {
    super(message)
    this.name = "TypedLinkError"
  }
}

/**
 * Both ends of a link must be in one workspace, and a NULL workspace on either end fails
 * closed. Returns the shared workspace id.
 */
export function assertSameWorkspacePair(
  left: { workspaceId: string | null | undefined },
  right: { workspaceId: string | null | undefined },
): string {
  const a = left.workspaceId
  const b = right.workspaceId
  if (!a || !b || a !== b) throw new TypedLinkError("Both ends of a link must belong to the same workspace.", "WORKSPACE_MISMATCH")
  return a
}

/** DSQL's write transaction cap is 3,000 rows and each link is 4 modified rows (row + 3 index entries). */
export const LINK_WRITE_CHUNK = 500

export const chunk = <T>(list: readonly T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

// ── Endpoint loading (always inside the caller's transaction) ───────────────

type Tx = AppTransactionClient

async function loadOpportunity(tx: Tx, id: string, expectedWorkspaceId?: string) {
  const row = await tx.opportunity.findFirst({
    where: { id, ...(expectedWorkspaceId ? { workspaceId: expectedWorkspaceId } : {}) },
    select: { id: true, workspaceId: true, title: true },
  })
  if (!row || !row.workspaceId) throw new TypedLinkError("Opportunity not found.")
  return row
}

async function loadSolution(tx: Tx, id: string, expectedWorkspaceId?: string) {
  const row = await tx.solution.findFirst({
    where: { id, ...(expectedWorkspaceId ? { workspaceId: expectedWorkspaceId } : {}) },
    select: { id: true, workspaceId: true, title: true },
  })
  // A Solution that carries no workspaceId of its own (not yet backfilled) is never authorized through its parent.
  if (!row || !row.workspaceId) throw new TypedLinkError("Solution not found.")
  return row as { id: string; workspaceId: string; title: string }
}

async function loadObjectiveIn(tx: Tx, id: string, workspaceId: string) {
  const row = await tx.objective.findFirst({ where: { id, workspaceId }, select: { id: true, workspaceId: true, title: true } })
  if (!row) throw new TypedLinkError("Objective not found in this workspace.")
  return row
}

async function loadKeyResultIn(tx: Tx, id: string, workspaceId: string) {
  // A key result has no workspace of its own: it is in the workspace of its Objective.
  const row = await tx.keyResult.findFirst({
    where: { id, objective: { workspaceId } },
    select: { id: true, title: true, objectiveId: true, objective: { select: { workspaceId: true } } },
  })
  if (!row) throw new TypedLinkError("Key Result not found in this workspace.")
  return row
}

// ── Transactions ────────────────────────────────────────────────────────────

const LINK_NAMES = /idx_entity_links_pair|entity_links|EntityLink\b/

/**
 * A lost race on the unique pair index. Prisma reports it as P2002, but a driver adapter does not necessarily fill `meta.modelName`,
 * so the unique-violation code (P2002, or Postgres 23505 on the error, its cause or the adapter metadata) is matched together with
 * ANY mention of the link model, table or pair index in the message, the model name or the metadata.
 * Verified against the repo's real client and adapter in typed-links-race.integration.test.ts.
 */
export function isLinkUniqueRace(error: unknown): boolean {
  const e = error as {
    code?: string
    message?: string
    meta?: { modelName?: string; code?: string; target?: unknown; driverAdapterError?: { cause?: { originalCode?: string; constraint?: unknown } } }
    cause?: { code?: string; message?: string; constraint?: string }
  } | null
  if (!e) return false
  const codes = [e.code, e.meta?.code, e.cause?.code, e.meta?.driverAdapterError?.cause?.originalCode]
  if (!codes.includes("P2002") && !codes.includes("23505")) return false
  let metaText = ""
  try {
    metaText = JSON.stringify(e.meta ?? {})
  } catch {
    // circular metadata: fall through to the message and the model name
  }
  return LINK_NAMES.test([e.message, e.meta?.modelName, e.cause?.message, e.cause?.constraint, metaText].filter(Boolean).join(" "))
}

/**
 * Runs `work` as one transaction with Compass's bounded OCC retry (40001 / OC000 / OC001 / P2034, via
 * withAtomicRetry), and re-runs it when two writers raced to insert the same pair: the retry's
 * read then finds the winner, which makes the call an idempotent no-op instead of an error.
 */
export async function runTypedLinkTransaction<T>(prisma: AppPrismaClient, work: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await withAtomicRetry(prisma, (tx) => work(tx))
    } catch (error) {
      if (!isLinkUniqueRace(error) || attempt >= 3) throw error
    }
  }
}

// ── Opportunity <-> Objective ───────────────────────────────────────────────

/**
 * Inserts the pair, or reconciles the existing one, without ON CONFLICT (lib/links/service.ts linkEntities):
 *   - missing: create with `origin`;
 *   - present, same origin: nothing to do;
 *   - want DIRECT over LEGACY: flip to DIRECT (also records who made it direct);
 *   - want LEGACY over DIRECT: keep DIRECT (never downgrade);
 *   - present with a drifted workspaceId: repaired to the verified one, since both endpoints were just checked there.
 */
async function upsertObjectiveTarget(
  tx: Tx,
  input: { workspaceId: string; opportunityId: string; objectiveId: string; origin: "DIRECT" | "LEGACY"; ctx: LinkContext },
) {
  const { linkEntities } = await entityLinkService()
  const result = await linkEntities(tx, {
    linkType: OPPORTUNITY_OBJECTIVE,
    fromId: input.opportunityId,
    toId: input.objectiveId,
    expectedWorkspaceId: input.workspaceId,
    origin: input.origin,
    ctx: input.ctx,
    viaDedicatedWriter: true,
    reconcileOrigin: true,
    keepDirectOrigin: true,
  })
  return { link: result.link, created: result.created, originFlipped: result.originFlipped }
}

export async function linkOpportunityToObjective(
  tx: Tx,
  input: { opportunityId: string; objectiveId: string; expectedWorkspaceId?: string; ctx: LinkContext },
) {
  const opportunity = await loadOpportunity(tx, input.opportunityId, input.expectedWorkspaceId)
  const objective = await loadObjectiveIn(tx, input.objectiveId, opportunity.workspaceId)
  const workspaceId = assertSameWorkspacePair(opportunity, objective)
  const result = await upsertObjectiveTarget(tx, { workspaceId, opportunityId: opportunity.id, objectiveId: objective.id, origin: "DIRECT", ctx: input.ctx })
  return { ...result, opportunity: { id: opportunity.id, title: opportunity.title, workspaceId }, objective: { id: objective.id, title: objective.title } }
}

export async function unlinkOpportunityFromObjective(
  tx: Tx,
  input: { opportunityId: string; objectiveId: string; expectedWorkspaceId?: string },
): Promise<{ removed: number; stillLinkedViaKeyResult?: boolean }> {
  const opportunity = await loadOpportunity(tx, input.opportunityId, input.expectedWorkspaceId)
  const { findLink, linkEntities, unlinkEntities } = await entityLinkService()
  const pair = { fromId: opportunity.id, toId: input.objectiveId, workspaceId: opportunity.workspaceId }
  const existing = await findLink(tx, { linkType: OPPORTUNITY_OBJECTIVE, ...pair })
  // A missing link is success (idempotent unlink); the sweep below also clears a row whose far end has since vanished.
  if (!existing) return { removed: 0 }

  // This function READS the opportunity's Key Result link to decide what to do. Touching the opportunity row makes that read part of
  // the write set, so a concurrent pointer change conflicts (DSQL detects write-write conflicts only) instead of write-skewing.
  await tx.opportunity.update({ where: { id: opportunity.id }, data: { updatedAt: new Date() } })

  // While the Key Result link still leads to this objective the pair is derived from it, and a later pointer write would put the
  // row straight back. Drop only a DIRECT claim (back to LEGACY) and say so.
  const [pointer] = await (await entityLinkReaders()).readEntityLinksOpportunityKeyResultPointer(tx, opportunity.workspaceId, { opportunityIds: [opportunity.id] })
  if (pointer) {
    const keyResult = await tx.keyResult.findFirst({ where: { id: pointer.toId, objective: { workspaceId: opportunity.workspaceId } }, select: { objectiveId: true } })
    if (keyResult?.objectiveId === input.objectiveId) {
      if (existing.origin === "DIRECT") {
        await linkEntities(tx, {
          linkType: OPPORTUNITY_OBJECTIVE,
          fromId: opportunity.id,
          toId: input.objectiveId,
          expectedWorkspaceId: opportunity.workspaceId,
          origin: "LEGACY",
          ctx: { source: existing.source as LinkSource, createdById: existing.createdById },
          viaDedicatedWriter: true,
          reconcileOrigin: true,
        })
      }
      return { removed: 0, stillLinkedViaKeyResult: true }
    }
  }
  const { removed } = await unlinkEntities(tx, { linkType: OPPORTUNITY_OBJECTIVE, fromId: opportunity.id, toId: input.objectiveId, expectedWorkspaceId: opportunity.workspaceId, viaDedicatedWriter: true })
  return { removed }
}

// ── Opportunity -> Key Result (the pointer) ─────────────────────────────────

/**
 * Brings the Opportunity's Key Result link and the objective links derived from it in line with `keyResultId`, inside the caller's
 * transaction:
 *   - every LEGACY objective link of this opportunity except the Key Result's objective is stale and is deleted (all of them when the
 *     pointer is cleared); DIRECT links are never touched;
 *   - the Key Result's objective gets a LEGACY link unless a link (DIRECT or LEGACY) already exists;
 *   - the OPPORTUNITY_TARGETS_KEY_RESULT row is replaced by the new one (removed when cleared).
 * The key result is verified to be in `workspaceId` first.
 */
export async function setKeyResultPointer(
  tx: Tx,
  input: { opportunityId: string; workspaceId: string; keyResultId: string | null; ctx: LinkContext },
): Promise<void> {
  const keyResult = input.keyResultId ? await loadKeyResultIn(tx, input.keyResultId, input.workspaceId) : null
  const { unlinkFromEntity, linkEntities } = await entityLinkService()
  await unlinkFromEntity(tx, {
    linkType: OPPORTUNITY_OBJECTIVE,
    fromId: input.opportunityId,
    expectedWorkspaceId: input.workspaceId,
    exceptToIds: keyResult ? [keyResult.objectiveId] : undefined,
    origin: "LEGACY",
  })
  if (keyResult) {
    await upsertObjectiveTarget(tx, {
      workspaceId: input.workspaceId,
      opportunityId: input.opportunityId,
      objectiveId: keyResult.objectiveId,
      origin: "LEGACY",
      ctx: input.ctx,
    })
  }
  // The pointer itself carries the Key Result granularity the Objective link cannot. It is to-one: the old row goes first.
  await unlinkFromEntity(tx, { linkType: OPPORTUNITY_KEY_RESULT, fromId: input.opportunityId, expectedWorkspaceId: input.workspaceId, exceptToIds: keyResult ? [keyResult.id] : undefined })
  if (keyResult) {
    await linkEntities(tx, {
      linkType: OPPORTUNITY_KEY_RESULT,
      fromId: input.opportunityId,
      toId: keyResult.id,
      expectedWorkspaceId: input.workspaceId,
      origin: "LEGACY",
      ctx: input.ctx,
      viaDedicatedWriter: true,
    })
  }
}

/**
 * Sets or clears an Opportunity's Key Result link together with the objective link derived from it. Call it from inside
 * `captureWorkspaceMutation(..., { atomic: true })` so the link write, the opportunity touch and any workspace-update capture commit as
 * one transaction. Returns the updated opportunity row, whose `linkedKeyResultId` is the value just set (the column itself is no longer
 * written).
 */
export async function setOpportunityKeyResult(
  tx: Tx,
  input: { opportunityId: string; keyResultId: string | null; expectedWorkspaceId?: string; ctx: LinkContext },
) {
  const opportunity = await loadOpportunity(tx, input.opportunityId, input.expectedWorkspaceId)
  // Verified before any write, so a denied call leaves the links untouched.
  if (input.keyResultId) await loadKeyResultIn(tx, input.keyResultId, opportunity.workspaceId)
  // updatedAt is explicit: it drives recency sort and the expectedUpdatedAt optimistic check, and an edit of the key result
  // from the opportunity header is an edit. updatedById only when a human made it (an agent carries no userId here).
  const updated = await tx.opportunity.update({
    where: { id: opportunity.id },
    data: { updatedAt: new Date(), ...(input.ctx.createdById ? { updatedById: input.ctx.createdById } : {}) },
  })
  await setKeyResultPointer(tx, { opportunityId: opportunity.id, workspaceId: opportunity.workspaceId, keyResultId: input.keyResultId, ctx: input.ctx })
  return { ...updated, linkedKeyResultId: input.keyResultId }
}

/** For creates that set the pointer in the same transaction: verifies the key result is in the workspace. */
export async function assertKeyResultInWorkspace(tx: Tx, keyResultId: string, workspaceId: string): Promise<void> {
  await loadKeyResultIn(tx, keyResultId, workspaceId)
}

// ── Solution <-> Key Result ─────────────────────────────────────────────────

export async function linkSolutionToKeyResult(
  tx: Tx,
  input: { solutionId: string; keyResultId: string; expectedWorkspaceId?: string; ctx: LinkContext },
) {
  const solution = await loadSolution(tx, input.solutionId, input.expectedWorkspaceId)
  const keyResult = await loadKeyResultIn(tx, input.keyResultId, solution.workspaceId)
  const workspaceId = assertSameWorkspacePair(solution, keyResult.objective)
  const { linkEntities } = await entityLinkService()
  const result = await linkEntities(tx, {
    linkType: SOLUTION_KEY_RESULT,
    fromId: solution.id,
    toId: keyResult.id,
    expectedWorkspaceId: workspaceId,
    ctx: input.ctx,
    viaDedicatedWriter: true,
  })
  return {
    link: result.link,
    created: result.created,
    solution: { id: solution.id, title: solution.title, workspaceId },
    keyResult: { id: keyResult.id, title: keyResult.title },
  }
}

export async function unlinkSolutionFromKeyResult(
  tx: Tx,
  input: { solutionId: string; keyResultId: string; expectedWorkspaceId?: string },
): Promise<{ removed: number }> {
  const solution = await loadSolution(tx, input.solutionId, input.expectedWorkspaceId)
  const { unlinkEntities } = await entityLinkService()
  const { removed } = await unlinkEntities(tx, { linkType: SOLUTION_KEY_RESULT, fromId: solution.id, toId: input.keyResultId, expectedWorkspaceId: solution.workspaceId, viaDedicatedWriter: true })
  return { removed }
}

// ── Deletes ─────────────────────────────────────────────────────────────────

export type LinkParentKind = "opportunity" | "objective" | "solution" | "keyResult"

/** Sweeps every link, of every type, that names one of `ids` as the parent of `kind` (explicit per kind: the delete-path contract test reads these calls). */
async function sweepLinksFor(db: Tx, kind: LinkParentKind, ids: readonly string[]): Promise<number> {
  const { deleteLinksForEntity } = await entityLinkService()
  if (kind === "opportunity") return deleteLinksForEntity(db, "OPPORTUNITY", ids)
  if (kind === "objective") return deleteLinksForEntity(db, "OBJECTIVE", ids)
  if (kind === "solution") return deleteLinksForEntity(db, "SOLUTION", ids)
  return deleteLinksForEntity(db, "KEY_RESULT", ids)
}

/**
 * Explicit link deletion for a parent that is going away (there are no foreign keys). Removes links of BOTH origins, and every other
 * link type, that name any of `ids`. Pass it the same transaction as the parent delete where there is one. Returns the number removed.
 *
 * A parent that may hold hundreds of links must be drained first with drainLinksFor (separate committed statements of at most 500
 * links), leaving only stragglers for this call.
 */
export async function deleteLinksFor(tx: Tx, kind: LinkParentKind, ids: readonly string[]): Promise<number> {
  return sweepLinksFor(tx, kind, ids)
}

type LinkRowFinder = (take: number) => Promise<{ id: string }[]>

/** Upper bound on passes (500 links each, so 1,000,000 links): a runaway loop becomes an error, never an endless one. */
const MAX_DRAIN_PASSES = 2_000
/** Consecutive passes that find rows but delete none before giving up. */
const MAX_STALLED_PASSES = 3

/**
 * Finds up to `take` link ids and deletes them by id, repeating until a FIND comes back empty. Each pass is its own statement.
 * A delete that removes nothing is not an error by itself: a concurrent drain (two delete clicks, or a user delete racing the
 * workspace cascade) took those rows first, so the find is simply run again and the loop ends when it is empty. Only repeated
 * stalls, or exceeding the pass cap, throw.
 */
export async function drainByIds(find: LinkRowFinder, remove: (ids: string[]) => Promise<number>): Promise<number> {
  let total = 0
  let stalled = 0
  for (let pass = 0; pass < MAX_DRAIN_PASSES; pass += 1) {
    const rows = await find(LINK_WRITE_CHUNK)
    if (rows.length === 0) return total
    const deleted = await remove(rows.map((row) => row.id))
    total += deleted
    stalled = deleted === 0 ? stalled + 1 : 0
    if (stalled >= MAX_STALLED_PASSES) throw new Error("Link delete made no progress")
  }
  throw new Error("Link drain exceeded its pass cap")
}

/**
 * Runs the link cleanup that follows a successful parent delete. ORDER MATTERS: the parent is deleted FIRST and its links are
 * drained AFTER, so a delete that is refused (a Restrict reference such as supporting objectives or check-ins, an OCC conflict, a
 * row cap) has touched no link. A link to a deleted endpoint is already hidden by the workspace-filtered endpoint joins and is
 * surfaced by linkIntegrity.directDangling, so a cleanup that fails is LOGGED and SWALLOWED, never surfaced as a failed delete the user
 * would retry against a parent that no longer exists. Returns how many links went.
 */
export async function drainAfterParentDelete(surface: string, cleanup: () => Promise<number>): Promise<{ removed: number; failed: boolean }> {
  try {
    return { removed: await cleanup(), failed: false }
  } catch (error) {
    // No row data: the surface and the error class only.
    console.error(JSON.stringify({ event: "typed_links.cleanup_failed", surface, error: error instanceof Error ? error.name : "unknown", hint: "leftover links are reported by linkIntegrity" }))
    return { removed: 0, failed: true }
  }
}

/**
 * Deletes every link naming a parent in `ids`, in committed passes of at most LINK_WRITE_CHUNK LINKS each (so no statement can
 * exceed DSQL's 3,000-row write cap however many links one parent has). Call it with the plain client BEFORE the parent-delete
 * transaction; it is idempotent and safe to repeat, and the transaction's deleteLinksFor then only sweeps stragglers.
 */
export async function drainLinksFor(db: Tx, kind: LinkParentKind, ids: readonly string[]): Promise<number> {
  return sweepLinksFor(db, kind, ids)
}

/**
 * drainLinksFor for the LEGACY (derived) objective links of opportunities whose Key Result is about to go; DIRECT links are kept.
 * With `objectiveId` only the link the deleted key result implied goes (a single pointer implies exactly one LEGACY link), so an
 * opportunity re-pointed elsewhere in the meantime keeps its new link.
 */
export async function drainLegacyLinksForOpportunities(db: Tx, opportunityIds: readonly string[], objectiveId?: string): Promise<number> {
  return (await entityLinkService()).drainLinksFromEntities(db, { linkType: OPPORTUNITY_OBJECTIVE, fromIds: opportunityIds, origin: "LEGACY", toId: objectiveId })
}

/**
 * drainLinksFor for the Opportunity -> Key Result pointer links that end at a Key Result that was just deleted, so the pointer count
 * stays separate from the Solution links drainLinksFor("keyResult") then removes. Committed passes of at most 500 links.
 */
export async function drainKeyResultPointers(db: Tx, keyResultId: string): Promise<number> {
  return (await entityLinkService()).drainLinksToEntities(db, { linkType: OPPORTUNITY_KEY_RESULT, toType: "KEY_RESULT", toIds: [keyResultId] })
}

/**
 * The LEGACY (derived) objective links of opportunities whose pointer is being cleared because their key result is deleted. DIRECT
 * links are kept: the user made them, and they are objective-level.
 */
export async function deleteLegacyLinksForOpportunities(tx: Tx, opportunityIds: readonly string[]): Promise<number> {
  return (await entityLinkService()).drainLinksFromEntities(tx, { linkType: OPPORTUNITY_OBJECTIVE, fromIds: opportunityIds, origin: "LEGACY" })
}

/**
 * Workspace teardown: every link row stamped with this workspace, in committed chunks (each statement is its own DSQL transaction and
 * each link is 4 modified rows). Runs BEFORE the opportunity, solution and objective deletes. Endpoint-keyed sweeps (deleteLinksFor)
 * cover rows whose workspaceId drifted. Returns the number removed.
 */
export async function deleteWorkspaceLinks(prisma: Tx, workspaceId: string): Promise<number> {
  return (await entityLinkService()).deleteWorkspaceLinks(prisma, workspaceId)
}

// ── Reads ───────────────────────────────────────────────────────────────────

export type LinkedObjective = { id: string; title: string }
export type LinkedKeyResult = { id: string; title: string; objectiveId: string }

/** Callers that already hold ids read under this workspace's own filter may skip the re-verification query. */
export type LinkReadOptions = { preverified?: boolean }

/**
 * Batch read: opportunityIds -> the objectives linked to each, ordered by link created_at then id.
 * Additive and deterministic. Every opportunity id that is in `workspaceId` appears in the map (empty
 * list when it has no links); ids outside the workspace are absent. A link is included only when
 * its objective is itself in the workspace, so a NULL / drifted objective is hidden.
 */
export async function getLinkedObjectivesByOpportunity(
  db: Tx,
  workspaceId: string,
  opportunityIds: readonly string[],
  options: LinkReadOptions = {},
): Promise<Map<string, LinkedObjective[]>> {
  const { readEntityLinksOpportunityObjective } = await entityLinkReaders()
  const result = new Map<string, LinkedObjective[]>()
  for (const ids of chunk([...new Set(opportunityIds)], LINK_WRITE_CHUNK)) {
    const verified = options.preverified
      ? new Set(ids)
      : new Set((await db.opportunity.findMany({ where: { id: { in: ids }, workspaceId }, select: { id: true } })).map((row) => row.id))
    if (verified.size === 0) continue
    const links = await readEntityLinksOpportunityObjective(db, workspaceId, { opportunityIds: [...verified] })
    const objectiveIds = [...new Set(links.map((link) => link.toId))]
    const objectives = objectiveIds.length ? await db.objective.findMany({ where: { id: { in: objectiveIds }, workspaceId }, select: { id: true, title: true } }) : []
    const titles = new Map(objectives.map((objective) => [objective.id, objective.title]))
    for (const id of verified) result.set(id, [])
    for (const link of links) {
      const title = titles.get(link.toId)
      if (title !== undefined) result.get(link.fromId)!.push({ id: link.toId, title })
    }
  }
  return result
}

/** The solution-side batch read, with the same filtering. A key result is in the workspace of its Objective. */
export async function getLinkedKeyResultsBySolution(
  db: Tx,
  workspaceId: string,
  solutionIds: readonly string[],
  options: LinkReadOptions = {},
): Promise<Map<string, LinkedKeyResult[]>> {
  const { readEntityLinksSolutionKeyResult } = await entityLinkReaders()
  const result = new Map<string, LinkedKeyResult[]>()
  for (const ids of chunk([...new Set(solutionIds)], LINK_WRITE_CHUNK)) {
    const verified = options.preverified
      ? new Set(ids)
      : new Set((await db.solution.findMany({ where: { id: { in: ids }, workspaceId }, select: { id: true } })).map((row) => row.id))
    if (verified.size === 0) continue
    const links = await readEntityLinksSolutionKeyResult(db, workspaceId, { solutionIds: [...verified] })
    const keyResultIds = [...new Set(links.map((link) => link.toId))]
    const keyResults = keyResultIds.length
      ? await db.keyResult.findMany({ where: { id: { in: keyResultIds }, objective: { workspaceId } }, select: { id: true, title: true, objectiveId: true } })
      : []
    const known = new Map(keyResults.map((kr) => [kr.id, kr]))
    for (const id of verified) result.set(id, [])
    for (const link of links) {
      const kr = known.get(link.toId)
      if (kr) result.get(link.fromId)!.push({ id: kr.id, title: kr.title, objectiveId: kr.objectiveId })
    }
  }
  return result
}

export type LinkedSolution = { id: string; title: string }

/**
 * The key-result-side batch read (the "Linked solutions" list on the Key Result panel): keyResultIds -> the
 * solutions linked to each, ordered by link created_at then id. A key result is in the workspace of its Objective; every
 * key result id that is in `workspaceId` appears in the map (empty list when it has no links), ids outside it are absent.
 * A link is included only when its Solution is itself in the workspace (the Solution's own workspaceId), so a NULL /
 * drifted Solution is hidden.
 */
export async function getLinkedSolutionsByKeyResult(
  db: Tx,
  workspaceId: string,
  keyResultIds: readonly string[],
  options: LinkReadOptions = {},
): Promise<Map<string, LinkedSolution[]>> {
  const { readEntityLinksSolutionKeyResult } = await entityLinkReaders()
  const result = new Map<string, LinkedSolution[]>()
  for (const ids of chunk([...new Set(keyResultIds)], LINK_WRITE_CHUNK)) {
    const verified = options.preverified
      ? new Set(ids)
      : new Set((await db.keyResult.findMany({ where: { id: { in: ids }, objective: { workspaceId } }, select: { id: true } })).map((row) => row.id))
    if (verified.size === 0) continue
    const links = await readEntityLinksSolutionKeyResult(db, workspaceId, { keyResultIds: [...verified] })
    const solutionIds = [...new Set(links.map((link) => link.fromId))]
    const solutions = solutionIds.length ? await db.solution.findMany({ where: { id: { in: solutionIds }, workspaceId }, select: { id: true, title: true } }) : []
    const titles = new Map(solutions.map((solution) => [solution.id, solution.title]))
    for (const id of verified) result.set(id, [])
    for (const link of links) {
      const title = titles.get(link.fromId)
      if (title !== undefined) result.get(link.toId)!.push({ id: link.fromId, title })
    }
  }
  return result
}

export type LinkedOpportunity = { id: string; title: string }

/**
 * The objective-side batch read (the "Linked opportunities" list on the Objective panel): objectiveIds -> the opportunities
 * linked directly to each, ordered by link created_at then id. Same contract as the readers above: every objective id that is in
 * `workspaceId` appears in the map (empty list when it has no links), ids outside it are absent, and a link is included only when its
 * Opportunity is itself in the workspace.
 */
export async function getLinkedOpportunitiesByObjective(
  db: Tx,
  workspaceId: string,
  objectiveIds: readonly string[],
  options: LinkReadOptions = {},
): Promise<Map<string, LinkedOpportunity[]>> {
  const { readEntityLinksOpportunityObjective } = await entityLinkReaders()
  const result = new Map<string, LinkedOpportunity[]>()
  for (const ids of chunk([...new Set(objectiveIds)], LINK_WRITE_CHUNK)) {
    const verified = options.preverified
      ? new Set(ids)
      : new Set((await db.objective.findMany({ where: { id: { in: ids }, workspaceId }, select: { id: true } })).map((row) => row.id))
    if (verified.size === 0) continue
    const links = await readEntityLinksOpportunityObjective(db, workspaceId, { objectiveIds: [...verified] })
    const opportunityIds = [...new Set(links.map((link) => link.fromId))]
    const opportunities = opportunityIds.length ? await db.opportunity.findMany({ where: { id: { in: opportunityIds }, workspaceId }, select: { id: true, title: true } }) : []
    const titles = new Map(opportunities.map((opportunity) => [opportunity.id, opportunity.title]))
    for (const id of verified) result.set(id, [])
    for (const link of links) {
      const title = titles.get(link.fromId)
      if (title !== undefined) result.get(link.toId)!.push({ id: link.fromId, title })
    }
  }
  return result
}

/** The link rows the canvas draws as edges. Ids only: titles and nodes come from the canvas's own workspace-filtered reads. */
export type CanvasLinkRows = {
  opportunityObjective: { opportunityId: string; objectiveId: string; origin: "DIRECT" | "LEGACY" }[]
  solutionKeyResult: { solutionId: string; keyResultId: string }[]
}

/**
 * Link rows for the canvas edge layer. The caller passes ids it read under its own workspace filter, so a link is returned only
 * when its opportunity / solution is one of them and both endpoints are live rows of the workspace; the canvas then drops a link whose
 * other endpoint is not a node it loaded, so nothing outside the workspace is ever drawn. `origins: "DIRECT"` narrows the
 * Opportunity<->Objective read to user-made links (the CLASSIC canvas shows only those). Chunked IN lists, no per-row reads.
 */
export async function getCanvasLinkRows(
  db: Tx,
  workspaceId: string,
  input: { opportunityIds: readonly string[]; solutionIds: readonly string[]; origins: "ALL" | "DIRECT" },
): Promise<CanvasLinkRows> {
  const { readEntityLinksOpportunityObjective, readEntityLinksSolutionKeyResult } = await entityLinkReaders()
  const [objectiveLinks, keyResultLinks] = await Promise.all([
    readEntityLinksOpportunityObjective(db, workspaceId, { opportunityIds: [...new Set(input.opportunityIds)], origins: input.origins }),
    readEntityLinksSolutionKeyResult(db, workspaceId, { solutionIds: [...new Set(input.solutionIds)] }),
  ])
  return {
    opportunityObjective: objectiveLinks.map((link) => ({ opportunityId: link.fromId, objectiveId: link.toId, origin: link.origin === "DIRECT" ? ("DIRECT" as const) : ("LEGACY" as const) })),
    solutionKeyResult: keyResultLinks.map((link) => ({ solutionId: link.fromId, keyResultId: link.toId })),
  }
}

/**
 * Each Opportunity's Key Result id (or null), for display / graph reads (canvas, discovery rail, outcome tree). Read from the
 * OPPORTUNITY_TARGETS_KEY_RESULT link; the caller passes the opportunity rows it already read (only `id` is used, so rows that still
 * carry the old `linked_key_result_id` column are fine and the column is ignored).
 */
export async function getOpportunityKeyResultPointers(
  db: Tx,
  workspaceId: string,
  rows: readonly { id: string }[],
): Promise<Map<string, string | null>> {
  const { readEntityLinksOpportunityKeyResultPointer } = await entityLinkReaders()
  const result = new Map<string, string | null>(rows.map((row) => [row.id, null]))
  if (rows.length === 0) return result
  const links = await readEntityLinksOpportunityKeyResultPointer(db, workspaceId, { opportunityIds: rows.map((row) => row.id) })
  for (const link of links) if (result.get(link.fromId) === null) result.set(link.fromId, link.toId)
  return result
}

export type ListLinksInput = {
  workspaceId: string
  opportunityId?: string
  objectiveId?: string
  solutionId?: string
  keyResultId?: string
  limit: number
  cursor?: string
}

export type ListedLink =
  | {
      kind: "opportunity_objective"
      id: string
      opportunityId: string
      opportunityTitle: string
      objectiveId: string
      objectiveTitle: string
      origin: string
      source: string
      createdAt: string
    }
  | {
      kind: "solution_key_result"
      id: string
      solutionId: string
      solutionTitle: string
      keyResultId: string
      keyResultTitle: string
      source: string
      createdAt: string
    }

export const encodeCursor = (row: { createdAt: Date; id: string }) => Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString("base64url")
export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8")
  const [iso, id, ...rest] = decoded.split("|")
  const createdAt = new Date(iso ?? "")
  if (!id || rest.length > 0 || Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== iso) throw new TypedLinkError("Invalid cursor.", "INVALID")
  return { createdAt, id }
}

/**
 * Keyset-paginated listing of the links on one entity (exactly one of opportunityId / objectiveId /
 * solutionId / keyResultId). The entity must be in `workspaceId`; the other endpoint is joined through a
 * workspace-filtered read and a link whose other endpoint is missing, NULL-workspace or foreign is left
 * out (so a page can hold fewer than `limit` rows without being the last).
 */
export async function listLinks(db: Tx, input: ListLinksInput): Promise<{ items: ListedLink[]; nextCursor: string | null }> {
  const { workspaceId } = input
  const filters = (["opportunityId", "objectiveId", "solutionId", "keyResultId"] as const).filter((key) => input[key])
  if (filters.length !== 1) throw new TypedLinkError("Provide exactly one of opportunityId, objectiveId, solutionId or keyResultId.", "INVALID")
  const cursor = input.cursor ? decodeCursor(input.cursor) : null
  const take = Math.min(Math.max(Math.trunc(input.limit) || 1, 1), 200)
  const finish = <T extends { createdAt: Date; id: string }>(rows: T[]) => ({
    rows: rows.slice(0, take),
    nextCursor: rows.length > take ? encodeCursor(rows[take - 1]) : null,
  })
  const filter = filters[0]
  const { listLinkRows } = await entityLinkService()

  if (filter === "opportunityId" || filter === "objectiveId") {
    if (filter === "opportunityId") {
      if (!(await db.opportunity.findFirst({ where: { id: input.opportunityId, workspaceId }, select: { id: true } }))) throw new TypedLinkError("Opportunity not found.")
    } else if (!(await db.objective.findFirst({ where: { id: input.objectiveId, workspaceId }, select: { id: true } }))) {
      throw new TypedLinkError("Objective not found in this workspace.")
    }
    const links = await listLinkRows(db, {
      linkType: OPPORTUNITY_OBJECTIVE,
      workspaceId,
      ...(filter === "opportunityId" ? { fromId: input.opportunityId } : { toId: input.objectiveId }),
      after: cursor,
      take: take + 1,
    })
    const { rows, nextCursor } = finish(links)
    const [opportunities, objectives] = await Promise.all([
      db.opportunity.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.fromId))] }, workspaceId }, select: { id: true, title: true } }),
      db.objective.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.toId))] }, workspaceId }, select: { id: true, title: true } }),
    ])
    const oppTitles = new Map(opportunities.map((o) => [o.id, o.title]))
    const objTitles = new Map(objectives.map((o) => [o.id, o.title]))
    const items: ListedLink[] = []
    for (const r of rows) {
      const opportunityTitle = oppTitles.get(r.fromId)
      const objectiveTitle = objTitles.get(r.toId)
      if (opportunityTitle === undefined || objectiveTitle === undefined) continue
      items.push({
        kind: "opportunity_objective",
        id: r.id,
        opportunityId: r.fromId,
        opportunityTitle,
        objectiveId: r.toId,
        objectiveTitle,
        origin: r.origin,
        source: r.source,
        createdAt: r.createdAt.toISOString(),
      })
    }
    return { items, nextCursor }
  }

  if (filter === "solutionId") await loadSolution(db, input.solutionId!, workspaceId)
  else await loadKeyResultIn(db, input.keyResultId!, workspaceId)
  const links = await listLinkRows(db, {
    linkType: SOLUTION_KEY_RESULT,
    workspaceId,
    ...(filter === "solutionId" ? { fromId: input.solutionId } : { toId: input.keyResultId }),
    after: cursor,
    take: take + 1,
  })
  const { rows, nextCursor } = finish(links)
  const [solutions, keyResults] = await Promise.all([
    db.solution.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.fromId))] }, workspaceId }, select: { id: true, title: true } }),
    db.keyResult.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.toId))] }, objective: { workspaceId } }, select: { id: true, title: true } }),
  ])
  const solTitles = new Map(solutions.map((s) => [s.id, s.title]))
  const krTitles = new Map(keyResults.map((k) => [k.id, k.title]))
  const items: ListedLink[] = []
  for (const r of rows) {
    const solutionTitle = solTitles.get(r.fromId)
    const keyResultTitle = krTitles.get(r.toId)
    if (solutionTitle === undefined || keyResultTitle === undefined) continue
    items.push({ kind: "solution_key_result", id: r.id, solutionId: r.fromId, solutionTitle, keyResultId: r.toId, keyResultTitle, source: r.source, createdAt: r.createdAt.toISOString() })
  }
  return { items, nextCursor }
}
