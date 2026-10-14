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
 *    raw Prisma writes, no link model named here.
 *  - A foreign row, a missing row, a non-member and a NULL-workspace row all return the
 *    SAME message, so the response never confirms that something exists elsewhere.
 *  - The paths to revalidate are built here from the authorized workspace's own slugs, never
 *    taken from the caller.
 *  - Authorization failures are told apart from infrastructure failures (a missing column, a
 *    database outage): the former answer with the shared message; the latter are logged by
 *    error name and code only and answer with a generic failure, so an outage is not
 *    mistaken for "not found".
 *
 * Both actions work whatever the thinking model is, because links are identical across
 * presets. Only the UI that offers them depends on it.
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
const FAILED = "Something went wrong. Please try again."

/** The only messages requireProductEntity throws for "you may not do this". Anything else is not an authorization result. */
const AUTHORIZATION_MESSAGES = new Set(["Unauthorized", "Entity not found or access denied"])

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 64

/** Error name and code only: the message of a database error can carry row data. */
function logFailure(stage: string, error: unknown) {
  const e = error as { name?: string; code?: string } | null
  console.error(JSON.stringify({ event: "objective_link.action_failed", stage, name: e?.name ?? "Error", code: e?.code ?? null }))
}

/**
 * Authorizes the pair and returns the workspace derived from the opportunity, or the
 * message to hand straight back. Never throws.
 */
async function authorizePair(opportunityId: unknown, objectiveId: unknown): Promise<{ workspaceId: string } | { error: string }> {
  if (!isId(opportunityId) || !isId(objectiveId)) return { error: BAD_INPUT }
  try {
    const { workspaceId } = await requireProductEntity("opportunity", opportunityId)
    await requireProductEntity("objective", objectiveId, workspaceId)
    return { workspaceId }
  } catch (error) {
    if (error instanceof Error && AUTHORIZATION_MESSAGES.has(error.message)) return { error: DENIED }
    logFailure("authorize", error)
    return { error: FAILED }
  }
}

/** Revalidates the screens that show these links, from the authorized workspace's own slugs. */
async function revalidateLinkScreens(workspaceId: string, opportunityId: string) {
  try {
    const workspace = await getPrisma().workspace.findUnique({
      where: { id: workspaceId },
      select: { slug: true, organization: { select: { slug: true } } },
    })
    if (!workspace?.organization?.slug) return
    const base = `/${workspace.organization.slug}/${workspace.slug}`
    revalidatePath(`${base}/discovery/${opportunityId}`)
    revalidatePath(`${base}/discovery/tree`)
    revalidatePath(`${base}/okrs`)
  } catch (error) {
    // The link is already written; a failed cache refresh must not turn it into an error.
    logFailure("revalidate", error)
  }
}

export async function linkOpportunityToObjectiveAction(opportunityId: string, objectiveId: string): Promise<ObjectiveLinkResult> {
  const authorized = await authorizePair(opportunityId, objectiveId)
  if ("error" in authorized) return { ok: false, error: authorized.error }
  try {
    const session = await auth()
    const result = await runTypedLinkTransaction(getPrisma(), (tx) =>
      linkOpportunityToObjective(tx, {
        opportunityId,
        objectiveId,
        expectedWorkspaceId: authorized.workspaceId,
        ctx: { source: "UI", createdById: session?.user?.id ?? null },
      }),
    )
    await revalidateLinkScreens(authorized.workspaceId, opportunityId)
    return { ok: true, changed: result.created || result.originFlipped }
  } catch (error) {
    if (error instanceof TypedLinkError) return { ok: false, error: DENIED }
    logFailure("link", error)
    return { ok: false, error: FAILED }
  }
}

export async function unlinkOpportunityFromObjectiveAction(opportunityId: string, objectiveId: string): Promise<ObjectiveLinkResult> {
  const authorized = await authorizePair(opportunityId, objectiveId)
  if ("error" in authorized) return { ok: false, error: authorized.error }
  try {
    const result = await runTypedLinkTransaction(getPrisma(), (tx) =>
      unlinkOpportunityFromObjective(tx, { opportunityId, objectiveId, expectedWorkspaceId: authorized.workspaceId }),
    )
    await revalidateLinkScreens(authorized.workspaceId, opportunityId)
    return {
      ok: true,
      changed: result.removed > 0,
      ...(result.stillLinkedViaKeyResult ? { stillLinkedViaKeyResult: true } : {}),
    }
  } catch (error) {
    if (error instanceof TypedLinkError) return { ok: false, error: DENIED }
    logFailure("unlink", error)
    return { ok: false, error: FAILED }
  }
}
