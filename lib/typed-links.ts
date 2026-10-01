/**
 * The single read/write module for the typed link tables (ADR: typed links between
 * Opportunities, Objectives, Key Results and Solutions; Phase 2):
 *
 *   opportunity_objective_links   Opportunity <-> Objective   (origin DIRECT | LEGACY)
 *   solution_key_result_links     Solution    <-> Key Result  (new-only, no legacy analogue)
 *
 * Nothing else in the codebase may name the two link models; a guard test
 * (__tests__/typed-link-tables-unused.test.ts) pins that. Every other file goes through
 * the functions below, so the invariants live in one reviewed place:
 *
 *  - TENANT SAFETY. A link row's `workspaceId` is ALWAYS copied from the authorized parent
 *    row (the opportunity or the solution), never from an input. Both endpoints are
 *    re-verified inside the same transaction with `findFirst({ id, workspaceId })`, so a
 *    caller that holds access to two workspaces still cannot cross-link them, and a row
 *    whose own workspaceId is NULL (an unbackfilled Solution/Objective) fails closed.
 *  - READS JOIN WORKSPACE-FILTERED ENDPOINTS. `link.workspaceId` alone is never trusted: a
 *    link is returned only when its other endpoint is itself in the requested workspace.
 *  - ORIGIN IS SINGLE-VALUED PER PAIR. The pair is unique, so a pair is either DIRECT (made
 *    through the link tools) or LEGACY (derived from Opportunity.linkedKeyResultId). Adding a
 *    DIRECT link over an existing LEGACY pair FLIPS it to DIRECT, so a later legacy clear can
 *    never delete a user-made link; a legacy write never downgrades a DIRECT one.
 *  - NO ON CONFLICT. It is unproven against DSQL's async unique index. Writes are
 *    read-then-write inside a transaction; a lost race surfaces as P2002 (or an OCC conflict)
 *    and the whole transaction is retried a bounded number of times, after which the repeat
 *    read sees the winner and the call is an idempotent no-op.
 */
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db"
import { withWorkspaceUpdates } from "@/lib/workspace-updates-capture"

export type LinkSource = "UI" | "MCP"
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

const chunk = <T>(list: readonly T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

// ── Endpoint loading (always inside the caller's transaction) ───────────────

type Tx = AppTransactionClient

async function loadOpportunity(tx: Tx, id: string, expectedWorkspaceId?: string) {
  const row = await tx.opportunity.findFirst({
    where: { id, ...(expectedWorkspaceId ? { workspaceId: expectedWorkspaceId } : {}) },
    select: { id: true, workspaceId: true, title: true, linkedKeyResultId: true },
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

const LINK_NAMES = /idx_(?:opportunity_objective|solution_key_result)_links_pair|opportunity_objective_links|solution_key_result_links|OpportunityObjectiveLink|SolutionKeyResultLink/

/**
 * A lost race on the unique pair index. Prisma reports it as P2002, but a driver adapter does not necessarily fill `meta.modelName`,
 * so the unique-violation code (P2002, or Postgres 23505 on the error, its cause or the adapter metadata) is matched together with
 * ANY mention of a link model, table or pair index in the message, the model name or the metadata.
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
 * withWorkspaceUpdates), and re-runs it when two writers raced to insert the same pair: the retry's
 * read then finds the winner, which makes the call an idempotent no-op instead of an error.
 */
export async function runTypedLinkTransaction<T>(prisma: AppPrismaClient, work: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await withWorkspaceUpdates(prisma, (tx) => work(tx), { atomic: true })
    } catch (error) {
      if (!isLinkUniqueRace(error) || attempt >= 3) throw error
    }
  }
}

// ── Opportunity <-> Objective ───────────────────────────────────────────────

type LinkRow = { id: string; workspaceId: string; opportunityId: string; objectiveId: string; origin: string; source: string; createdAt: Date }

/**
 * Inserts the pair, or reconciles the existing one, without ON CONFLICT.
 *   - missing: create with `origin`;
 *   - present, same origin: nothing to do;
 *   - want DIRECT over LEGACY: flip to DIRECT (also records who made it direct);
 *   - want LEGACY over DIRECT: keep DIRECT (never downgrade);
 *   - present with a drifted workspaceId: repaired to the verified one, since both endpoints were just checked there.
 */
async function upsertOpportunityObjectiveLink(
  tx: Tx,
  input: { workspaceId: string; opportunityId: string; objectiveId: string; origin: "DIRECT" | "LEGACY"; ctx: LinkContext },
): Promise<{ link: LinkRow; created: boolean; originFlipped: boolean }> {
  const { workspaceId, opportunityId, objectiveId, origin, ctx } = input
  const existing = (await tx.opportunityObjectiveLink.findFirst({ where: { opportunityId, objectiveId } })) as LinkRow | null
  if (!existing) {
    const link = (await tx.opportunityObjectiveLink.create({
      data: { workspaceId, opportunityId, objectiveId, origin, source: ctx.source, createdById: ctx.createdById ?? null },
    })) as LinkRow
    return { link, created: true, originFlipped: false }
  }
  const flip = origin === "DIRECT" && existing.origin !== "DIRECT"
  const repair = existing.workspaceId !== workspaceId
  if (!flip && !repair) return { link: existing, created: false, originFlipped: false }
  const link = (await tx.opportunityObjectiveLink.update({
    where: { id: existing.id },
    data: {
      ...(repair ? { workspaceId } : {}),
      ...(flip ? { origin: "DIRECT", source: ctx.source, createdById: ctx.createdById ?? null } : {}),
    },
  })) as LinkRow
  return { link, created: false, originFlipped: flip }
}

export async function linkOpportunityToObjective(
  tx: Tx,
  input: { opportunityId: string; objectiveId: string; expectedWorkspaceId?: string; ctx: LinkContext },
) {
  const opportunity = await loadOpportunity(tx, input.opportunityId, input.expectedWorkspaceId)
  const objective = await loadObjectiveIn(tx, input.objectiveId, opportunity.workspaceId)
  const workspaceId = assertSameWorkspacePair(opportunity, objective)
  const result = await upsertOpportunityObjectiveLink(tx, { workspaceId, opportunityId: opportunity.id, objectiveId: objective.id, origin: "DIRECT", ctx: input.ctx })
  return { ...result, opportunity: { id: opportunity.id, title: opportunity.title, workspaceId }, objective: { id: objective.id, title: objective.title } }
}

export async function unlinkOpportunityFromObjective(
  tx: Tx,
  input: { opportunityId: string; objectiveId: string; expectedWorkspaceId?: string },
): Promise<{ removed: number; stillLinkedViaKeyResult?: boolean }> {
  const opportunity = await loadOpportunity(tx, input.opportunityId, input.expectedWorkspaceId)
  const where = { opportunityId: opportunity.id, objectiveId: input.objectiveId, workspaceId: opportunity.workspaceId }
  const existing = (await tx.opportunityObjectiveLink.findFirst({ where })) as LinkRow | null
  if (!existing) return { removed: 0 }

  // This function READS the opportunity's pointer to decide what to do. Touching the opportunity row makes that read part of the
  // write set, so a concurrent pointer change conflicts (DSQL detects write-write conflicts only) instead of write-skewing.
  await tx.opportunity.update({ where: { id: opportunity.id }, data: { updatedAt: new Date() } })

  // While the legacy pointer still leads to this objective the pair is derived from it, and a later
  // backfill would put the row straight back. Drop only a DIRECT claim (back to LEGACY) and say so.
  if (opportunity.linkedKeyResultId) {
    const pointer = await tx.keyResult.findFirst({
      where: { id: opportunity.linkedKeyResultId, objective: { workspaceId: opportunity.workspaceId } },
      select: { objectiveId: true },
    })
    if (pointer?.objectiveId === input.objectiveId) {
      if (existing.origin === "DIRECT") await tx.opportunityObjectiveLink.update({ where: { id: existing.id }, data: { origin: "LEGACY" } })
      return { removed: 0, stillLinkedViaKeyResult: true }
    }
  }
  const { count } = await tx.opportunityObjectiveLink.deleteMany({ where: { id: existing.id, workspaceId: opportunity.workspaceId } })
  return { removed: count }
}

// ── Opportunity.linkedKeyResultId dual-write (legacy pointer) ───────────────

/**
 * Brings the LEGACY link in line with the pointer, inside the caller's transaction:
 *   - every LEGACY link of this opportunity except the pointer's objective is stale and is deleted
 *     (all of them when the pointer is cleared); DIRECT links are never touched;
 *   - the pointer's objective gets a LEGACY link unless a link (DIRECT or LEGACY) already exists.
 * The key result is verified to be in `workspaceId` first.
 */
export async function syncLegacyLink(
  tx: Tx,
  input: { opportunityId: string; workspaceId: string; keyResultId: string | null; ctx: LinkContext },
): Promise<void> {
  const keyResult = input.keyResultId ? await loadKeyResultIn(tx, input.keyResultId, input.workspaceId) : null
  await tx.opportunityObjectiveLink.deleteMany({
    where: {
      opportunityId: input.opportunityId,
      origin: "LEGACY",
      ...(keyResult ? { objectiveId: { not: keyResult.objectiveId } } : {}),
    },
  })
  if (keyResult) {
    await upsertOpportunityObjectiveLink(tx, {
      workspaceId: input.workspaceId,
      opportunityId: input.opportunityId,
      objectiveId: keyResult.objectiveId,
      origin: "LEGACY",
      ctx: input.ctx,
    })
  }
}

/**
 * Sets or clears Opportunity.linkedKeyResultId and the LEGACY link together. Call it from inside
 * `captureWorkspaceMutation(..., { atomic: true })` so the column write, the link write and any
 * workspace-update capture commit as one transaction. Returns the updated opportunity row.
 */
export async function setOpportunityKeyResult(
  tx: Tx,
  input: { opportunityId: string; keyResultId: string | null; expectedWorkspaceId?: string; ctx: LinkContext },
) {
  const opportunity = await loadOpportunity(tx, input.opportunityId, input.expectedWorkspaceId)
  // Verified before any write, so a denied call leaves both the column and the links untouched.
  if (input.keyResultId) await loadKeyResultIn(tx, input.keyResultId, opportunity.workspaceId)
  // updatedAt is explicit: it drives recency sort and the expectedUpdatedAt optimistic check, and an edit of the key result
  // from the opportunity header is an edit. updatedById only when a human made it (an agent carries no userId here).
  const updated = await tx.opportunity.update({
    where: { id: opportunity.id },
    data: { linkedKeyResultId: input.keyResultId, updatedAt: new Date(), ...(input.ctx.createdById ? { updatedById: input.ctx.createdById } : {}) },
  })
  await syncLegacyLink(tx, { opportunityId: opportunity.id, workspaceId: opportunity.workspaceId, keyResultId: input.keyResultId, ctx: input.ctx })
  return updated
}

/** For creates that set the pointer in the same transaction: verifies the key result is in the workspace. */
export async function assertKeyResultInWorkspace(tx: Tx, keyResultId: string, workspaceId: string): Promise<void> {
  await loadKeyResultIn(tx, keyResultId, workspaceId)
}

// ── Solution <-> Key Result ─────────────────────────────────────────────────

type SolutionLinkRow = { id: string; workspaceId: string; solutionId: string; keyResultId: string; source: string; createdAt: Date }

export async function linkSolutionToKeyResult(
  tx: Tx,
  input: { solutionId: string; keyResultId: string; expectedWorkspaceId?: string; ctx: LinkContext },
) {
  const solution = await loadSolution(tx, input.solutionId, input.expectedWorkspaceId)
  const keyResult = await loadKeyResultIn(tx, input.keyResultId, solution.workspaceId)
  const workspaceId = assertSameWorkspacePair(solution, keyResult.objective)
  const existing = (await tx.solutionKeyResultLink.findFirst({ where: { solutionId: solution.id, keyResultId: keyResult.id } })) as SolutionLinkRow | null
  const shared = { solution: { id: solution.id, title: solution.title, workspaceId }, keyResult: { id: keyResult.id, title: keyResult.title } }
  if (existing) {
    if (existing.workspaceId === workspaceId) return { link: existing, created: false, ...shared }
    const link = (await tx.solutionKeyResultLink.update({ where: { id: existing.id }, data: { workspaceId } })) as SolutionLinkRow
    return { link, created: false, ...shared }
  }
  const link = (await tx.solutionKeyResultLink.create({
    data: { workspaceId, solutionId: solution.id, keyResultId: keyResult.id, source: input.ctx.source, createdById: input.ctx.createdById ?? null },
  })) as SolutionLinkRow
  return { link, created: true, ...shared }
}

export async function unlinkSolutionFromKeyResult(
  tx: Tx,
  input: { solutionId: string; keyResultId: string; expectedWorkspaceId?: string },
): Promise<{ removed: number }> {
  const solution = await loadSolution(tx, input.solutionId, input.expectedWorkspaceId)
  const { count } = await tx.solutionKeyResultLink.deleteMany({
    where: { solutionId: solution.id, keyResultId: input.keyResultId, workspaceId: solution.workspaceId },
  })
  return { removed: count }
}

// ── Deletes ─────────────────────────────────────────────────────────────────

export type LinkParentKind = "opportunity" | "objective" | "solution" | "keyResult"

/**
 * Explicit link deletion for a parent that is going away (there are no foreign keys and Prisma's
 * emulated relations do not reach these tables). Removes links of BOTH origins that name any of
 * `ids`. Pass it the same transaction as the parent delete where there is one. Returns the number removed.
 *
 * It splits the PARENT ids into chunks of 500, not the links: every chunk is one statement, and inside a transaction all chunks
 * share DSQL's 3,000-modified-row cap (4 rows per link: the row plus 3 index entries, so about 750 links). A parent that may hold
 * hundreds of links must be drained first with drainLinksFor (separate committed statements of at most 500 links), leaving only
 * stragglers for this call.
 */
export async function deleteLinksFor(tx: Tx, kind: LinkParentKind, ids: readonly string[]): Promise<number> {
  let removed = 0
  for (const part of chunk(ids, LINK_WRITE_CHUNK)) {
    if (kind === "opportunity") removed += (await tx.opportunityObjectiveLink.deleteMany({ where: { opportunityId: { in: part } } })).count
    else if (kind === "objective") removed += (await tx.opportunityObjectiveLink.deleteMany({ where: { objectiveId: { in: part } } })).count
    else if (kind === "solution") removed += (await tx.solutionKeyResultLink.deleteMany({ where: { solutionId: { in: part } } })).count
    else removed += (await tx.solutionKeyResultLink.deleteMany({ where: { keyResultId: { in: part } } })).count
  }
  return removed
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
async function drainByIds(find: LinkRowFinder, remove: (ids: string[]) => Promise<number>): Promise<number> {
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
 * surfaced by linkIntegrity.directDangling (and pruned by 072 if LEGACY), so a cleanup that fails is LOGGED and SWALLOWED, never
 * surfaced as a failed delete the user would retry against a parent that no longer exists. Returns how many links went.
 */
export async function drainAfterParentDelete(surface: string, cleanup: () => Promise<number>): Promise<{ removed: number; failed: boolean }> {
  try {
    return { removed: await cleanup(), failed: false }
  } catch (error) {
    // No row data: the surface and the error class only.
    console.error(JSON.stringify({ event: "typed_links.cleanup_failed", surface, error: error instanceof Error ? error.name : "unknown", hint: "leftover links are reported by linkIntegrity and pruned by 072" }))
    return { removed: 0, failed: true }
  }
}

/**
 * Deletes every link naming a parent in `ids`, in committed passes of at most LINK_WRITE_CHUNK LINKS each (so no statement can
 * exceed DSQL's 3,000-row write cap however many links one parent has). Call it with the plain client BEFORE the parent-delete
 * transaction; it is idempotent and safe to repeat, and the transaction's deleteLinksFor then only sweeps stragglers.
 */
export async function drainLinksFor(db: Tx, kind: LinkParentKind, ids: readonly string[]): Promise<number> {
  let removed = 0
  for (const part of chunk(ids, LINK_WRITE_CHUNK)) {
    if (kind === "opportunity" || kind === "objective") {
      const where = kind === "opportunity" ? { opportunityId: { in: part } } : { objectiveId: { in: part } }
      removed += await drainByIds(
        (take) => db.opportunityObjectiveLink.findMany({ where, select: { id: true }, take }),
        async (rowIds) => (await db.opportunityObjectiveLink.deleteMany({ where: { id: { in: rowIds } } })).count,
      )
    } else {
      const where = kind === "solution" ? { solutionId: { in: part } } : { keyResultId: { in: part } }
      removed += await drainByIds(
        (take) => db.solutionKeyResultLink.findMany({ where, select: { id: true }, take }),
        async (rowIds) => (await db.solutionKeyResultLink.deleteMany({ where: { id: { in: rowIds } } })).count,
      )
    }
  }
  return removed
}

/** drainLinksFor for the LEGACY links of opportunities whose pointer is about to be cleared (DIRECT links are kept). */
export async function drainLegacyLinksForOpportunities(db: Tx, opportunityIds: readonly string[], objectiveId?: string): Promise<number> {
  let removed = 0
  for (const part of chunk(opportunityIds, LINK_WRITE_CHUNK)) {
    removed += await drainByIds(
      // With objectiveId only the link the deleted key result implied goes (a single pointer implies exactly one LEGACY link),
      // so an opportunity re-pointed elsewhere in the meantime keeps its new link.
      (take) => db.opportunityObjectiveLink.findMany({ where: { opportunityId: { in: part }, origin: "LEGACY", ...(objectiveId ? { objectiveId } : {}) }, select: { id: true }, take }),
      async (rowIds) => (await db.opportunityObjectiveLink.deleteMany({ where: { id: { in: rowIds } } })).count,
    )
  }
  return removed
}

/**
 * The LEGACY links of opportunities whose pointer is being cleared because their key result is
 * deleted. DIRECT links are kept: the user made them, and they are objective-level.
 */
export async function deleteLegacyLinksForOpportunities(tx: Tx, opportunityIds: readonly string[]): Promise<number> {
  let removed = 0
  for (const part of chunk(opportunityIds, LINK_WRITE_CHUNK)) {
    removed += (await tx.opportunityObjectiveLink.deleteMany({ where: { opportunityId: { in: part }, origin: "LEGACY" } })).count
  }
  return removed
}

/**
 * Workspace teardown: every link row stamped with this workspace, in chunks (each statement is its
 * own DSQL transaction and each link is 4 modified rows). Runs BEFORE the opportunity, solution and
 * objective deletes. Endpoint-keyed sweeps (deleteLinksFor) cover rows whose workspaceId drifted.
 */
export async function deleteWorkspaceLinks(prisma: AppTransactionClient, workspaceId: string): Promise<{ opportunityObjective: number; solutionKeyResult: number }> {
  return {
    opportunityObjective: await drainByIds(
      (take) => prisma.opportunityObjectiveLink.findMany({ where: { workspaceId }, select: { id: true }, take }),
      async (ids) => (await prisma.opportunityObjectiveLink.deleteMany({ where: { id: { in: ids } } })).count,
    ),
    solutionKeyResult: await drainByIds(
      (take) => prisma.solutionKeyResultLink.findMany({ where: { workspaceId }, select: { id: true }, take }),
      async (ids) => (await prisma.solutionKeyResultLink.deleteMany({ where: { id: { in: ids } } })).count,
    ),
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

export type LinkedObjective = { id: string; title: string }
export type LinkedKeyResult = { id: string; title: string; objectiveId: string }

const byCreatedThenId = (a: { createdAt: Date; id: string }, b: { createdAt: Date; id: string }) =>
  a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// Reads FAIL LOUDLY: if a link table is missing (code deployed before migration 071) the database error propagates, exactly like every
// write, delete and the link tools. There is deliberately no "no links" fallback.
/** Callers that already hold ids read under this workspace's own filter may skip the re-verification query. */
export type LinkReadOptions = { preverified?: boolean }

/**
 * Batch read: opportunityIds -> the objectives linked to each, ordered by link created_at then id.
 * Additive and deterministic. Every opportunity id that is in `workspaceId` appears in the map (empty
 * list when it has no links); ids outside the workspace are absent. A link is included only when
 * its objective is itself in the workspace, so a NULL / drifted objective is hidden, as in #331.
 */
export async function getLinkedObjectivesByOpportunity(
  db: Tx,
  workspaceId: string,
  opportunityIds: readonly string[],
  options: LinkReadOptions = {},
): Promise<Map<string, LinkedObjective[]>> {
  const result = new Map<string, LinkedObjective[]>()
  for (const ids of chunk([...new Set(opportunityIds)], LINK_WRITE_CHUNK)) {
    const verified = options.preverified
      ? new Set(ids)
      : new Set((await db.opportunity.findMany({ where: { id: { in: ids }, workspaceId }, select: { id: true } })).map((row) => row.id))
    if (verified.size === 0) continue
    const links = (await db.opportunityObjectiveLink.findMany({
      where: { workspaceId, opportunityId: { in: [...verified] } },
      select: { id: true, opportunityId: true, objectiveId: true, createdAt: true },
    })) as { id: string; opportunityId: string; objectiveId: string; createdAt: Date }[]
    const objectiveIds = [...new Set(links.map((link) => link.objectiveId))]
    const objectives = objectiveIds.length
      ? await db.objective.findMany({ where: { id: { in: objectiveIds }, workspaceId }, select: { id: true, title: true } })
      : []
    const titles = new Map(objectives.map((objective) => [objective.id, objective.title]))
    for (const id of verified) result.set(id, [])
    for (const link of links.sort(byCreatedThenId)) {
      const title = titles.get(link.objectiveId)
      if (title !== undefined) result.get(link.opportunityId)!.push({ id: link.objectiveId, title })
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
  const result = new Map<string, LinkedKeyResult[]>()
  for (const ids of chunk([...new Set(solutionIds)], LINK_WRITE_CHUNK)) {
    const verified = options.preverified
      ? new Set(ids)
      : new Set((await db.solution.findMany({ where: { id: { in: ids }, workspaceId }, select: { id: true } })).map((row) => row.id))
    if (verified.size === 0) continue
    const links = (await db.solutionKeyResultLink.findMany({
      where: { workspaceId, solutionId: { in: [...verified] } },
      select: { id: true, solutionId: true, keyResultId: true, createdAt: true },
    })) as { id: string; solutionId: string; keyResultId: string; createdAt: Date }[]
    const keyResultIds = [...new Set(links.map((link) => link.keyResultId))]
    const keyResults = keyResultIds.length
      ? await db.keyResult.findMany({ where: { id: { in: keyResultIds }, objective: { workspaceId } }, select: { id: true, title: true, objectiveId: true } })
      : []
    const known = new Map(keyResults.map((kr) => [kr.id, kr]))
    for (const id of verified) result.set(id, [])
    for (const link of links.sort(byCreatedThenId)) {
      const kr = known.get(link.keyResultId)
      if (kr) result.get(link.solutionId)!.push({ id: kr.id, title: kr.title, objectiveId: kr.objectiveId })
    }
  }
  return result
}

export type LinkedSolution = { id: string; title: string }

/**
 * The key-result-side batch read (Phase 4B, the "Linked solutions" list on the Key Result panel): keyResultIds -> the
 * solutions linked to each, ordered by link created_at then id. A key result is in the workspace of its Objective; every
 * key result id that is in `workspaceId` appears in the map (empty list when it has no links), ids outside it are absent.
 * A link is included only when its Solution is itself in the workspace (the Solution's own workspaceId), so a NULL /
 * drifted Solution is hidden. Tolerant of a missing link table, like the other batch reads.
 */
export async function getLinkedSolutionsByKeyResult(
  db: Tx,
  workspaceId: string,
  keyResultIds: readonly string[],
  options: LinkReadOptions = {},
): Promise<Map<string, LinkedSolution[]>> {
  const result = new Map<string, LinkedSolution[]>()
  for (const ids of chunk([...new Set(keyResultIds)], LINK_WRITE_CHUNK)) {
    const verified = options.preverified
      ? new Set(ids)
      : new Set((await db.keyResult.findMany({ where: { id: { in: ids }, objective: { workspaceId } }, select: { id: true } })).map((row) => row.id))
    if (verified.size === 0) continue
    const links = (await tolerantLinkRead("solution-key-result", () =>
      db.solutionKeyResultLink.findMany({
        where: { workspaceId, keyResultId: { in: [...verified] } },
        select: { id: true, solutionId: true, keyResultId: true, createdAt: true },
      }),
    )) as { id: string; solutionId: string; keyResultId: string; createdAt: Date }[]
    const solutionIds = [...new Set(links.map((link) => link.solutionId))]
    const solutions = solutionIds.length
      ? await db.solution.findMany({ where: { id: { in: solutionIds }, workspaceId }, select: { id: true, title: true } })
      : []
    const titles = new Map(solutions.map((solution) => [solution.id, solution.title]))
    for (const id of verified) result.set(id, [])
    for (const link of links.sort(byCreatedThenId)) {
      const title = titles.get(link.solutionId)
      if (title !== undefined) result.get(link.keyResultId)!.push({ id: link.solutionId, title })
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
 * when its opportunity / solution is one of them; the canvas then drops a link whose other endpoint is not a node it loaded
 * (a NULL / foreign Objective, Key Result), so nothing outside the workspace is ever drawn. `origins: "DIRECT"` narrows the
 * Opportunity<->Objective read to user-made links (the CLASSIC canvas must not change just because migration 071 backfilled
 * LEGACY rows). Chunked IN lists, one query per chunk, no per-row reads. A missing link table yields no rows (the canvas
 * simply omits link edges); any other error keeps throwing.
 */
export async function getCanvasLinkRows(
  db: Tx,
  workspaceId: string,
  input: { opportunityIds: readonly string[]; solutionIds: readonly string[]; origins: "ALL" | "DIRECT" },
): Promise<CanvasLinkRows> {
  const opportunityObjective: CanvasLinkRows["opportunityObjective"] = []
  for (const ids of chunk([...new Set(input.opportunityIds)], LINK_WRITE_CHUNK)) {
    const rows = (await tolerantLinkRead("canvas-opportunity-objective", () =>
      db.opportunityObjectiveLink.findMany({
        where: { workspaceId, opportunityId: { in: ids }, ...(input.origins === "DIRECT" ? { origin: "DIRECT" } : {}) },
        select: { id: true, opportunityId: true, objectiveId: true, origin: true, createdAt: true },
      }),
    )) as { id: string; opportunityId: string; objectiveId: string; origin: string; createdAt: Date }[]
    for (const row of rows.sort(byCreatedThenId)) {
      opportunityObjective.push({ opportunityId: row.opportunityId, objectiveId: row.objectiveId, origin: row.origin === "DIRECT" ? "DIRECT" : "LEGACY" })
    }
  }
  const solutionKeyResult: CanvasLinkRows["solutionKeyResult"] = []
  for (const ids of chunk([...new Set(input.solutionIds)], LINK_WRITE_CHUNK)) {
    const rows = (await tolerantLinkRead("canvas-solution-key-result", () =>
      db.solutionKeyResultLink.findMany({
        where: { workspaceId, solutionId: { in: ids } },
        select: { id: true, solutionId: true, keyResultId: true, createdAt: true },
      }),
    )) as { id: string; solutionId: string; keyResultId: string; createdAt: Date }[]
    for (const row of rows.sort(byCreatedThenId)) solutionKeyResult.push({ solutionId: row.solutionId, keyResultId: row.keyResultId })
  }
  return { opportunityObjective, solutionKeyResult }
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

const encodeCursor = (row: { createdAt: Date; id: string }) => Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString("base64url")
function decodeCursor(cursor: string): { createdAt: Date; id: string } {
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
  const page = {
    orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
    take: take + 1,
  }
  const after = cursor ? { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] } : {}
  const finish = <T extends { createdAt: Date; id: string }>(rows: T[]) => ({
    rows: rows.slice(0, take),
    nextCursor: rows.length > take ? encodeCursor(rows[take - 1]) : null,
  })
  const filter = filters[0]

  if (filter === "opportunityId" || filter === "objectiveId") {
    if (filter === "opportunityId") {
      if (!(await db.opportunity.findFirst({ where: { id: input.opportunityId, workspaceId }, select: { id: true } }))) throw new TypedLinkError("Opportunity not found.")
    } else if (!(await db.objective.findFirst({ where: { id: input.objectiveId, workspaceId }, select: { id: true } }))) {
      throw new TypedLinkError("Objective not found in this workspace.")
    }
    const links = (await db.opportunityObjectiveLink.findMany({
      where: { AND: [{ workspaceId, [filter]: input[filter] }, after] },
      ...page,
    })) as LinkRow[]
    const { rows, nextCursor } = finish(links)
    const [opportunities, objectives] = await Promise.all([
      db.opportunity.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.opportunityId))] }, workspaceId }, select: { id: true, title: true } }),
      db.objective.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.objectiveId))] }, workspaceId }, select: { id: true, title: true } }),
    ])
    const oppTitles = new Map(opportunities.map((o) => [o.id, o.title]))
    const objTitles = new Map(objectives.map((o) => [o.id, o.title]))
    const items: ListedLink[] = []
    for (const r of rows) {
      const opportunityTitle = oppTitles.get(r.opportunityId)
      const objectiveTitle = objTitles.get(r.objectiveId)
      if (opportunityTitle === undefined || objectiveTitle === undefined) continue
      items.push({
        kind: "opportunity_objective",
        id: r.id,
        opportunityId: r.opportunityId,
        opportunityTitle,
        objectiveId: r.objectiveId,
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
  const links = (await db.solutionKeyResultLink.findMany({
    where: { AND: [{ workspaceId, [filter]: input[filter] }, after] },
    ...page,
  })) as SolutionLinkRow[]
  const { rows, nextCursor } = finish(links)
  const [solutions, keyResults] = await Promise.all([
    db.solution.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.solutionId))] }, workspaceId }, select: { id: true, title: true } }),
    db.keyResult.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.keyResultId))] }, objective: { workspaceId } }, select: { id: true, title: true } }),
  ])
  const solTitles = new Map(solutions.map((s) => [s.id, s.title]))
  const krTitles = new Map(keyResults.map((k) => [k.id, k.title]))
  const items: ListedLink[] = []
  for (const r of rows) {
    const solutionTitle = solTitles.get(r.solutionId)
    const keyResultTitle = krTitles.get(r.keyResultId)
    if (solutionTitle === undefined || keyResultTitle === undefined) continue
    items.push({ kind: "solution_key_result", id: r.id, solutionId: r.solutionId, solutionTitle, keyResultId: r.keyResultId, keyResultTitle, source: r.source, createdAt: r.createdAt.toISOString() })
  }
  return { items, nextCursor }
}
