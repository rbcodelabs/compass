"use server"

/**
 * UI actions behind the Opportunity <-> Objective picker (Phase 3C).
 *
 * A server action is a public POST endpoint, so nothing here trusts the client:
 *
 *  - The workspace is DERIVED from the authorized opportunity row
 *    (requireProductEntity requires the caller's membership), never taken from input.
 *  - The Objective is then checked against THAT workspace (the pair check), so a member
 *    of two workspaces cannot link across them, and an Objective whose own workspaceId is
 *    NULL fails closed.
 *  - The write goes through lib/typed-links.ts only (it copies the link row's workspaceId
 *    from the parent, re-reads both endpoints in the transaction, and retries OCC). No
 *    raw Prisma, no link model named here.
 *  - A foreign row, a missing row, a non-member and a NULL-workspace row all return the
 *    SAME message, so the response never confirms that something exists elsewhere.
 *
 * Both actions are presentation-independent: they work whatever the thinking model is,
 * because links are identical across presets. Only the UI that offers them depends on it.
 */

import { revalidatePath } from "next/cache"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { requireProductEntity } from "@/lib/product-action-auth"
import {
  TypedLinkError,
  linkOpportunityToObjective,
  runTypedLinkTransaction,
  unlinkOpportunityFromObjective,
} from "@/lib/typed-links"

export type ObjectiveLinkResult =
  | { ok: true; changed: boolean; stillLinkedViaKeyResult?: boolean }
  | { ok: false; error: string }

const DENIED = "Entity not found or access denied"
const BAD_INPUT = "Invalid request"

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 64

/**
 * Authorizes the pair and returns the workspace derived from the opportunity, or
 * a result to hand straight back. Never throws for an expected denial.
 */
async function authorizePair(opportunityId: unknown, objectiveId: unknown): Promise<{ workspaceId: string } | { error: string }> {
  if (!isId(opportunityId) || !isId(objectiveId)) return { error: BAD_INPUT }
  try {
    const { workspaceId } = await requireProductEntity("opportunity", opportunityId)
    await requireProductEntity("objective", objectiveId, workspaceId)
    return { workspaceId }
  } catch {
    // Unauthenticated, not a member, not found, other workspace, NULL workspace: all one message.
    return { error: DENIED }
  }
}

function safeRevalidate(path: unknown) {
  // A relative app path only; anything else is ignored rather than trusted.
  if (typeof path === "string" && path.startsWith("/") && !path.startsWith("//")) revalidatePath(path)
}

export async function linkOpportunityToObjectiveAction(
  opportunityId: string,
  objectiveId: string,
  revalidatePathStr: string,
): Promise<ObjectiveLinkResult> {
  const authorized = await authorizePair(opportunityId, objectiveId)
  if ("error" in authorized) return { ok: false, error: authorized.error }
  const session = await auth()
  try {
    const result = await runTypedLinkTransaction(getPrisma(), (tx) =>
      linkOpportunityToObjective(tx, {
        opportunityId,
        objectiveId,
        expectedWorkspaceId: authorized.workspaceId,
        ctx: { source: "UI", createdById: session?.user?.id ?? null },
      }),
    )
    safeRevalidate(revalidatePathStr)
    return { ok: true, changed: result.created || result.originFlipped }
  } catch (error) {
    if (error instanceof TypedLinkError) return { ok: false, error: DENIED }
    throw error
  }
}

export async function unlinkOpportunityFromObjectiveAction(
  opportunityId: string,
  objectiveId: string,
  revalidatePathStr: string,
): Promise<ObjectiveLinkResult> {
  const authorized = await authorizePair(opportunityId, objectiveId)
  if ("error" in authorized) return { ok: false, error: authorized.error }
  try {
    const result = await runTypedLinkTransaction(getPrisma(), (tx) =>
      unlinkOpportunityFromObjective(tx, { opportunityId, objectiveId, expectedWorkspaceId: authorized.workspaceId }),
    )
    safeRevalidate(revalidatePathStr)
    return {
      ok: true,
      changed: result.removed > 0,
      ...(result.stillLinkedViaKeyResult ? { stillLinkedViaKeyResult: true } : {}),
    }
  } catch (error) {
    if (error instanceof TypedLinkError) return { ok: false, error: DENIED }
    throw error
  }
}
