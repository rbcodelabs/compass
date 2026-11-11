/**
 * The single writer of task links (ADR "One generic entity_links table", phase 7). entity_links is the only store for the nine
 * ASSOCIATION targets (Opportunity, Solution, Roadmap Item, Objective, Key Result, Doc, Experiment, Feedback Item and Decision, the
 * TASK_REFERENCES link type); each write below runs through lib/links/service.ts in the caller's transaction, so a link commits or rolls
 * back with whatever else the caller writes.
 *
 * Link kinds that are NOT associations stay in task_links, because they never lived in entity_links and no migration moved them: COMMENT
 * (the Doc comment a task was made from), AGENT_CONVERSATION and anything else unknown. This module is the only writer of those rows too,
 * so a caller never has to know which store a kind lives in. A link keeps the spelling callers already use (`DECISION`, not the stored
 * `REVIEW_REQUEST`).
 *
 * Link ids: a reference link's id is its entity_links row id; a residual link's id is its task_links row id. `deleteTaskLinkById` accepts
 * either, and also a pre-cleanup task_links id of a reference link (an open page that still holds one) by resolving it to its pair.
 */
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db"
import { TASK_REFERENCE_TARGET_TYPES } from "@/lib/links/registry"
import { deleteLinksForEntity, drainLinksToEntities, findLink, findLinkById, linkEntities, unlinkEntities } from "@/lib/links/service"
import { runTypedLinkTransaction, type LinkContext } from "@/lib/typed-links"

const TASK_REFERENCES = "TASK_REFERENCES"

type ReferenceType = (typeof TASK_REFERENCE_TARGET_TYPES)[number]

/** The `linked_type` spellings that are associations, mapped to their stored `to_type`: DECISION is a review request. */
const LEGACY_TO_STORED = {
  OPPORTUNITY: "OPPORTUNITY", SOLUTION: "SOLUTION", ROADMAP_ITEM: "ROADMAP_ITEM", OBJECTIVE: "OBJECTIVE", KEY_RESULT: "KEY_RESULT",
  DOC: "DOC", EXPERIMENT: "EXPERIMENT", FEEDBACK_ITEM: "FEEDBACK_ITEM", DECISION: "REVIEW_REQUEST",
} as const satisfies Record<string, ReferenceType>

/** The stored target type of an association spelling, or null for a residual kind (COMMENT, AGENT_CONVERSATION, unknown, or a stored spelling). */
export function taskReferenceTargetType(linkedType: string): ReferenceType | null {
  return Object.prototype.hasOwnProperty.call(LEGACY_TO_STORED, linkedType) ? LEGACY_TO_STORED[linkedType as keyof typeof LEGACY_TO_STORED] : null
}

/** The spelling callers use for a stored `to_type` (REVIEW_REQUEST -> DECISION). */
export function taskLinkedTypeOf(storedType: string): string {
  return storedType === "REVIEW_REQUEST" ? "DECISION" : storedType
}

/** The `linked_type` spellings that live in entity_links; every other kind is residual. */
export const TASK_REFERENCE_LINKED_TYPES = Object.keys(LEGACY_TO_STORED) as (keyof typeof LEGACY_TO_STORED)[]

export type TaskLinkRecord = { id: string; taskId: string; linkedType: string; linkedId: string; source?: string | null; createdById?: string | null; createdAt?: Date }
export type TaskLinkInput = { linkedType: string; linkedId: string; source?: string | null; createdById?: string | null }

const asLinkSource = (source: string | null | undefined): LinkContext["source"] => (source === "MCP" || source === "API" || source === "AGENT" ? source : "UI")

type Tx = AppTransactionClient

/** Creates one link in `tx` (idempotent for a reference: a repeat returns the existing row). The task and the target are verified by the service. */
async function createInTx(tx: Tx, input: { workspaceId: string; taskId: string; link: TaskLinkInput }): Promise<TaskLinkRecord> {
  const { workspaceId, taskId, link } = input
  const toType = taskReferenceTargetType(link.linkedType)
  if (!toType) {
    const row = await tx.taskLink.create({ data: { taskId, linkedType: link.linkedType, linkedId: link.linkedId } })
    return { id: row.id, taskId, linkedType: row.linkedType, linkedId: row.linkedId, source: row.source, createdById: row.createdById, createdAt: row.createdAt }
  }
  const result = await linkEntities(tx, {
    linkType: TASK_REFERENCES,
    fromId: taskId,
    toId: link.linkedId,
    toType,
    expectedWorkspaceId: workspaceId,
    origin: "DIRECT",
    ctx: { source: asLinkSource(link.source), createdById: link.createdById ?? null },
    viaDedicatedWriter: true,
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
  const toType = taskReferenceTargetType(input.linkedType)
  if (!toType) {
    const row = await db.taskLink.findFirst({ where: { taskId: input.taskId, linkedType: input.linkedType, linkedId: input.linkedId } })
    return row ? { id: row.id, taskId: row.taskId, linkedType: row.linkedType, linkedId: row.linkedId, source: row.source, createdById: row.createdById, createdAt: row.createdAt } : null
  }
  const row = await findLink(db, { linkType: TASK_REFERENCES, fromId: input.taskId, toId: input.linkedId, workspaceId: input.workspaceId })
  return row && row.toType === toType ? { id: row.id, taskId: input.taskId, linkedType: input.linkedType, linkedId: row.toId, source: row.source, createdById: row.createdById, createdAt: row.createdAt } : null
}

/** What deleting a link needs to know about it. */
export type ResolvedTaskLink = { id: string; taskId: string; linkedType: string; linkedId: string }

/** Resolves a link id from the UI to the link, whichever store it lives in; null when it is gone. */
export async function getTaskLinkById(db: AppPrismaClient | Tx, linkId: string): Promise<ResolvedTaskLink | null> {
  const client = db as Tx
  const reference = await findLinkById(client, linkId)
  if (reference && reference.linkType === TASK_REFERENCES) return { id: reference.id, taskId: reference.fromId, linkedType: taskLinkedTypeOf(reference.toType), linkedId: reference.toId }
  const row = await client.taskLink.findUnique({ where: { id: linkId }, select: { id: true, taskId: true, linkedType: true, linkedId: true } })
  return row
}

/** Deletes a link in `tx`. For a reference only the task is verified, so a link whose target has since vanished stays removable. */
async function deleteInTx(tx: Tx, link: ResolvedTaskLink, workspaceId: string): Promise<void> {
  if (taskReferenceTargetType(link.linkedType)) {
    await unlinkEntities(tx, { linkType: TASK_REFERENCES, fromId: link.taskId, toId: link.linkedId, expectedWorkspaceId: workspaceId, viaDedicatedWriter: true })
    // A task_links row of a reference kind (written before the cleanup, or the stale id an open page still holds) goes with it.
    await tx.taskLink.deleteMany({ where: { taskId: link.taskId, linkedType: link.linkedType, linkedId: link.linkedId } })
    return
  }
  await tx.taskLink.deleteMany({ where: { id: link.id } })
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
 * Deletes the residual links (COMMENT, AGENT_CONVERSATION) that point at deleted targets, for example the Doc comments a task was made
 * from. Runs in the caller's transaction so it commits with the delete. Association kinds are not touched (see drainTaskLinksTo).
 */
export async function deleteResidualLinksTo(tx: Tx, input: { linkedType: string; linkedIds: readonly string[] }): Promise<number> {
  if (taskReferenceTargetType(input.linkedType) || input.linkedIds.length === 0) return 0
  return (await tx.taskLink.deleteMany({ where: { linkedType: input.linkedType, linkedId: { in: [...input.linkedIds] } } })).count
}

/**
 * Workspace teardown: every link of the given tasks, whichever store holds it (entity_links by endpoint, so a drifted workspace_id is
 * covered too, and the residual task_links rows, which block the task delete through their emulated Restrict). The caller chunks.
 */
export async function deleteLinksOfTasks(db: Tx, taskIds: readonly string[]): Promise<void> {
  if (taskIds.length === 0) return
  await deleteLinksForEntity(db, "TASK", taskIds)
  await db.taskLink.deleteMany({ where: { taskId: { in: [...taskIds] } } })
}
