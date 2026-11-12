/**
 * The single writer of task links (ADR "One generic entity_links table", phase 7). entity_links is the only store, in two link types, and
 * each write below runs through lib/links/service.ts in the caller's transaction, so a link commits or rolls back with whatever else the
 * caller writes:
 *  - TASK_REFERENCES: the nine ASSOCIATION targets (Opportunity, Solution, Roadmap Item, Objective, Key Result, Doc, Experiment, Feedback
 *    Item and Decision), moved by migration 097;
 *  - TASK_CREATED_FROM: the two ORIGINS (the Comment a task was made from, the agent conversation that made it), moved by migration 115.
 * This module is the only writer of both, so a caller never has to know which type a kind lives in. A link keeps the spelling callers
 * already use (`DECISION`, not the stored `REVIEW_REQUEST`).
 *
 * Link ids: a link's id is its entity_links row id. Migration 115 keeps the task_links id on the row it copies, so the id an open page
 * holds for an origin link survives the move. `getTaskLinkById` also resolves a legacy task_links id (see lib/legacy-link-tables.ts).
 *
 * DEPLOY BEFORE MIGRATION. This code ships before migration 115 runs. Until then every origin link made BEFORE the deploy exists only in
 * task_links, so lookups fall back to the frozen rows (lib/legacy-link-tables.ts) and a delete removes the pair from both stores. New
 * links go to entity_links only. Nothing is ever written to task_links.
 */
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db"
import { TASK_CREATED_FROM_LINK_TYPE, TASK_ORIGIN_TARGET_TYPES, TASK_REFERENCE_TARGET_TYPES } from "@/lib/links/registry"
import { deleteLinksForEntity, drainLinksToEntities, findLink, findLinkById, linkEntities, unlinkEntities } from "@/lib/links/service"
import { deleteFrozenTaskLinks, deleteLegacyTaskLinkPair, deleteLegacyTaskLinksTo, findLegacyTaskLinkById, readUnmovedTaskLinks } from "@/lib/legacy-link-tables"
import { runTypedLinkTransaction, TypedLinkError, type LinkContext } from "@/lib/typed-links"

const TASK_REFERENCES = "TASK_REFERENCES"

type ReferenceType = (typeof TASK_REFERENCE_TARGET_TYPES)[number]
type OriginType = (typeof TASK_ORIGIN_TARGET_TYPES)[number]

/** The `linked_type` spellings that are associations, mapped to their stored `to_type`: DECISION is a review request. */
const LEGACY_TO_STORED = {
  OPPORTUNITY: "OPPORTUNITY", SOLUTION: "SOLUTION", ROADMAP_ITEM: "ROADMAP_ITEM", OBJECTIVE: "OBJECTIVE", KEY_RESULT: "KEY_RESULT",
  DOC: "DOC", EXPERIMENT: "EXPERIMENT", FEEDBACK_ITEM: "FEEDBACK_ITEM", DECISION: "REVIEW_REQUEST",
} as const satisfies Record<string, ReferenceType>

/** The stored target type of an association spelling, or null for an origin kind (COMMENT, AGENT_CONVERSATION), an unknown kind or a stored spelling. */
export function taskReferenceTargetType(linkedType: string): ReferenceType | null {
  return Object.prototype.hasOwnProperty.call(LEGACY_TO_STORED, linkedType) ? LEGACY_TO_STORED[linkedType as keyof typeof LEGACY_TO_STORED] : null
}

/** The spelling callers use for a stored `to_type` (REVIEW_REQUEST -> DECISION). */
export function taskLinkedTypeOf(storedType: string): string {
  return storedType === "REVIEW_REQUEST" ? "DECISION" : storedType
}

/** The `linked_type` spellings of the associations (TASK_REFERENCES). */
export const TASK_REFERENCE_LINKED_TYPES = Object.keys(LEGACY_TO_STORED) as (keyof typeof LEGACY_TO_STORED)[]

/** The origin kind (COMMENT | AGENT_CONVERSATION, TASK_CREATED_FROM) of a `linked_type`, or null. */
export function taskOriginTargetType(linkedType: string): OriginType | null {
  return (TASK_ORIGIN_TARGET_TYPES as readonly string[]).includes(linkedType) ? (linkedType as OriginType) : null
}

/** Which entity_links type and stored target a `linked_type` lives under; null for a kind that is neither. */
function storeOf(linkedType: string): { linkType: string; toType: ReferenceType | OriginType } | null {
  const reference = taskReferenceTargetType(linkedType)
  if (reference) return { linkType: TASK_REFERENCES, toType: reference }
  const origin = taskOriginTargetType(linkedType)
  return origin ? { linkType: TASK_CREATED_FROM_LINK_TYPE, toType: origin } : null
}

export type TaskLinkRecord = { id: string; taskId: string; linkedType: string; linkedId: string; source?: string | null; createdById?: string | null; createdAt?: Date }
export type TaskLinkInput = { linkedType: string; linkedId: string; source?: string | null; createdById?: string | null }

const asLinkSource = (source: string | null | undefined): LinkContext["source"] => (source === "MCP" || source === "API" || source === "AGENT" ? source : "UI")

type Tx = AppTransactionClient

/** Creates one link in `tx` (idempotent: a repeat returns the existing row). The task and the target are verified by the service. */
async function createInTx(tx: Tx, input: { workspaceId: string; taskId: string; link: TaskLinkInput }): Promise<TaskLinkRecord> {
  const { workspaceId, taskId, link } = input
  const store = storeOf(link.linkedType)
  if (!store) throw new TypedLinkError(`Unsupported task link type "${link.linkedType}".`, "INVALID")
  const result = await linkEntities(tx, {
    linkType: store.linkType,
    fromId: taskId,
    toId: link.linkedId,
    toType: store.toType,
    expectedWorkspaceId: workspaceId,
    origin: "DIRECT",
    ctx: { source: asLinkSource(link.source), createdById: link.createdById ?? null },
    viaDedicatedWriter: true,
    viaInternalWriter: store.linkType === TASK_CREATED_FROM_LINK_TYPE,
  })
  return { id: result.link.id, taskId, linkedType: taskLinkedTypeOf(result.link.toType), linkedId: result.link.toId, source: result.link.source, createdById: result.link.createdById, createdAt: result.link.createdAt }
}

/** Creates links in the caller's transaction (for example right after a task create). Returns them in input order. */
export async function createTaskLinks(tx: Tx, input: { workspaceId: string; taskId: string; links: readonly TaskLinkInput[] }): Promise<TaskLinkRecord[]> {
  const out: TaskLinkRecord[] = []
  for (const link of input.links) out.push(await createInTx(tx, { workspaceId: input.workspaceId, taskId: input.taskId, link }))
  return out
}

/** Creates one link in its own retried transaction. A repeat returns the existing link. */
export async function createTaskLink(
  prisma: AppPrismaClient,
  input: { taskId: string; linkedType: string; linkedId: string; workspaceId: string; source?: string | null; createdById?: string | null },
): Promise<TaskLinkRecord> {
  return runTypedLinkTransaction(prisma, async (tx) => {
    const existing = await findTaskLinkIn(tx, input)
    if (existing) return existing
    return createInTx(tx, { workspaceId: input.workspaceId, taskId: input.taskId, link: input })
  })
}

/** The link between a task and a target, or null. Checks the store the kind lives in. */
export async function findTaskLink(db: AppPrismaClient | Tx, input: { taskId: string; linkedType: string; linkedId: string; workspaceId: string }): Promise<TaskLinkRecord | null> {
  return findTaskLinkIn(db as Tx, input)
}

async function findTaskLinkIn(db: Tx, input: { taskId: string; linkedType: string; linkedId: string; workspaceId: string }): Promise<TaskLinkRecord | null> {
  const store = storeOf(input.linkedType)
  if (!store) return null
  const row = await findLink(db, { linkType: store.linkType, fromId: input.taskId, toId: input.linkedId, workspaceId: input.workspaceId })
  if (row && row.toType === store.toType) return { id: row.id, taskId: input.taskId, linkedType: input.linkedType, linkedId: row.toId, source: row.source, createdById: row.createdById, createdAt: row.createdAt }
  if (store.linkType !== TASK_CREATED_FROM_LINK_TYPE) return null
  // Not moved yet (migration 115 has not run, or this link is newer than its copy): the frozen row still stands for the pair.
  const [legacy] = await readUnmovedTaskLinks(db, { taskIds: [input.taskId], linkedType: input.linkedType, linkedIds: [input.linkedId], workspaceId: input.workspaceId })
  return legacy ?? null
}

/** What deleting a link needs to know about it. */
export type ResolvedTaskLink = { id: string; taskId: string; linkedType: string; linkedId: string }

/** Resolves a link id from the UI to the link; null when it is gone. */
export async function getTaskLinkById(db: AppPrismaClient | Tx, linkId: string): Promise<ResolvedTaskLink | null> {
  const client = db as Tx
  const link = await findLinkById(client, linkId)
  if (link && (link.linkType === TASK_REFERENCES || link.linkType === TASK_CREATED_FROM_LINK_TYPE)) {
    return { id: link.id, taskId: link.fromId, linkedType: taskLinkedTypeOf(link.toType), linkedId: link.toId }
  }
  return findLegacyTaskLinkById(client, linkId)
}

/** Deletes a link in `tx`. Only the task is verified, so a link whose target has since vanished stays removable. */
async function deleteInTx(tx: Tx, link: ResolvedTaskLink, workspaceId: string): Promise<void> {
  const store = storeOf(link.linkedType)
  if (store) {
    await unlinkEntities(tx, {
      linkType: store.linkType, fromId: link.taskId, toId: link.linkedId, expectedWorkspaceId: workspaceId,
      viaDedicatedWriter: true, viaInternalWriter: store.linkType === TASK_CREATED_FROM_LINK_TYPE,
    })
  }
  // The frozen row of the same pair goes with it, or the pre-migration fallback would bring the link back.
  await deleteLegacyTaskLinkPair(tx, { taskId: link.taskId, linkedType: link.linkedType, linkedId: link.linkedId })
}

/** Deletes a link in its own retried transaction. */
export async function deleteTaskLink(prisma: AppPrismaClient, input: { link: ResolvedTaskLink; workspaceId: string }): Promise<void> {
  await runTypedLinkTransaction(prisma, (tx) => deleteInTx(tx, input.link, input.workspaceId))
}

/** Removes a link by task, kind and target (the unlink-by-pair tools). Returns whether a link existed. */
export async function deleteTaskLinkByPair(prisma: AppPrismaClient, input: { taskId: string; linkedType: string; linkedId: string; workspaceId: string }): Promise<boolean> {
  return runTypedLinkTransaction(prisma, async (tx) => {
    const existing = await findTaskLinkIn(tx, input)
    if (!existing) return false
    await deleteInTx(tx, existing, input.workspaceId)
    return true
  })
}

/**
 * Removes every task link to deleted targets (deleteObjective, deleteKeyResult), in committed passes of at most 500 links. Run it AFTER
 * the delete commits (drainAfterParentDelete): a failure leaves dangling rows that readers already hide.
 */
export async function drainTaskLinksTo(db: Tx, input: { linkedType: string; linkedIds: readonly string[] }): Promise<number> {
  const toType = taskReferenceTargetType(input.linkedType)
  if (!toType) return 0
  return drainLinksToEntities(db, { linkType: TASK_REFERENCES, toType, toIds: input.linkedIds })
}

/**
 * Deletes the origin links (COMMENT, AGENT_CONVERSATION) that point at deleted targets, for example the comments a task was made from.
 * Runs in the caller's transaction so it commits with the delete. Association kinds are not touched (see drainTaskLinksTo).
 */
export async function deleteOriginLinksTo(tx: Tx, input: { linkedType: string; linkedIds: readonly string[] }): Promise<number> {
  if (!taskOriginTargetType(input.linkedType) || input.linkedIds.length === 0) return 0
  // A deleted comment or conversation keeps no link of any type, so the sweep is by endpoint (only TASK_CREATED_FROM ends at either today).
  const moved = input.linkedType === "COMMENT" ? await deleteLinksForEntity(tx, "COMMENT", input.linkedIds) : await deleteLinksForEntity(tx, "AGENT_CONVERSATION", input.linkedIds)
  return moved + (await deleteLegacyTaskLinksTo(tx, input))
}

/**
 * Workspace teardown: every link of the given tasks (entity_links by endpoint, so a drifted workspace_id is covered too, and the frozen
 * task_links rows, which block the task delete through their emulated Restrict). The caller chunks.
 */
export async function deleteLinksOfTasks(db: Tx, taskIds: readonly string[]): Promise<void> {
  if (taskIds.length === 0) return
  await deleteLinksForEntity(db, "TASK", taskIds)
  await deleteFrozenTaskLinks(db, { taskIds })
}
