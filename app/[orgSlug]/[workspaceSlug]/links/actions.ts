"use server"

/**
 * UI actions behind the shared LinkedEntitiesSection (ADR phase 3). A server action is a public POST
 * endpoint, so nothing here trusts the client:
 *
 *  - The workspace is resolved from the slug pair WITH the caller's membership in the same query
 *    (requireProductWorkspaceBySlug); a guessable slug is never enough.
 *  - The link type must be a registry key; the viewed entity must be one of its endpoint types. Which end is
 *    `from` is derived from the registry, never from the caller.
 *  - The write goes through lib/links/service.ts only: it re-verifies both endpoints in the workspace inside
 *    the transaction, applies the registry's eligibility and feature-flag rules, and copies the stored
 *    workspace from the `from` row. Linking changes nothing else (no status, protocol or credential).
 *  - A TypedLinkError carries a user-safe message and is returned as such; anything else is logged by name and
 *    code only and answers with a generic failure.
 */

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { normalizeEntityType, type LinkableEntityType } from "@/lib/entity-types"
import { entityPath } from "@/lib/links/entity-routes"
import { getLinkType, toTypesOf } from "@/lib/links/registry"
import { getLinkedEntitiesView, type LinkedEntitiesView } from "@/lib/links/read-models"
import { linkEntities, unlinkEntities } from "@/lib/links/service"
import { requireProductWorkspaceBySlug } from "@/lib/product-action-auth"
import { TypedLinkError, runTypedLinkTransaction } from "@/lib/typed-links"

export type ReadLinksResult = { ok: true; view: LinkedEntitiesView | null } | { ok: false; error: string }
export type ChangeLinkResult = { ok: true; changed: boolean } | { ok: false; error: string }

const DENIED = "Not found or access denied"
const FAILED = "Something went wrong. Please try again."

const scopeSchema = z.object({ orgSlug: z.string().trim().min(1).max(255), workspaceSlug: z.string().trim().min(1).max(255) })
const targetSchema = z.object({ linkType: z.string().min(1).max(60), entityType: z.string().min(1).max(40), entityId: z.string().uuid() })

function logFailure(stage: string, error: unknown) {
  const e = error as { name?: string; code?: string } | null
  console.error(JSON.stringify({ event: "entity_link.action_failed", stage, name: e?.name ?? "Error", code: e?.code ?? null }))
}

async function authorizeWorkspace(orgSlug: string, workspaceSlug: string): Promise<{ workspaceId: string } | { error: string }> {
  const scope = scopeSchema.safeParse({ orgSlug, workspaceSlug })
  if (!scope.success) return { error: DENIED }
  try {
    return { workspaceId: await requireProductWorkspaceBySlug(scope.data.orgSlug, scope.data.workspaceSlug) }
  } catch (error) {
    if (error instanceof Error && (error.message === "Unauthorized" || error.message === "Workspace not found or access denied")) return { error: DENIED }
    logFailure("authorize", error)
    return { error: FAILED }
  }
}

function failure(stage: string, error: unknown): { ok: false; error: string } {
  if (error instanceof TypedLinkError) return { ok: false, error: error.message }
  logFailure(stage, error)
  return { ok: false, error: FAILED }
}

export async function readEntityLinks(orgSlug: string, workspaceSlug: string, target: { linkType: string; entityType: string; entityId: string }, search = ""): Promise<ReadLinksResult> {
  const parsed = targetSchema.safeParse(target)
  if (!parsed.success || typeof search !== "string" || search.length > 255) return { ok: false, error: DENIED }
  const authorized = await authorizeWorkspace(orgSlug, workspaceSlug)
  if ("error" in authorized) return { ok: false, error: authorized.error }
  try {
    const view = await getLinkedEntitiesView(getPrisma(), { workspaceId: authorized.workspaceId, ...parsed.data, query: search })
    return { ok: true, view }
  } catch (error) {
    return failure("read", error)
  }
}

export async function changeEntityLink(
  orgSlug: string,
  workspaceSlug: string,
  input: { linkType: string; entityType: string; entityId: string; otherId: string; operation: "link" | "unlink" },
): Promise<ChangeLinkResult> {
  const parsed = targetSchema.extend({ otherId: z.string().uuid(), operation: z.enum(["link", "unlink"]) }).safeParse(input)
  if (!parsed.success) return { ok: false, error: DENIED }
  const { linkType, entityId, otherId, operation } = parsed.data
  const def = getLinkType(linkType)
  const entityType: LinkableEntityType | null = normalizeEntityType(parsed.data.entityType)
  if (!def || !entityType) return { ok: false, error: DENIED }
  const isFrom = def.from === entityType
  if (!isFrom && !toTypesOf(def).includes(entityType)) return { ok: false, error: DENIED }
  const authorized = await authorizeWorkspace(orgSlug, workspaceSlug)
  if ("error" in authorized) return { ok: false, error: authorized.error }

  const fromId = isFrom ? entityId : otherId
  const toId = isFrom ? otherId : entityId
  try {
    const session = await auth()
    const changed = await runTypedLinkTransaction(getPrisma(), async (tx) => {
      if (operation === "link") {
        const result = await linkEntities(tx, {
          linkType: def.key,
          fromId,
          toId,
          expectedWorkspaceId: authorized.workspaceId,
          ctx: { source: "UI", createdById: session?.user?.id ?? null },
        })
        return result.created
      }
      const result = await unlinkEntities(tx, { linkType: def.key, fromId, toId, expectedWorkspaceId: authorized.workspaceId })
      return result.removed > 0
    })
    revalidateLinkScreens(orgSlug, workspaceSlug, [{ type: def.from, id: fromId }, { type: toTypesOf(def)[0], id: toId }])
    return { ok: true, changed }
  } catch (error) {
    return failure(operation, error)
  }
}

/** The slugs were just proven to name a workspace the caller belongs to; the ids are only used inside those paths. */
function revalidateLinkScreens(orgSlug: string, workspaceSlug: string, ends: Array<{ type: LinkableEntityType; id: string }>) {
  try {
    for (const end of ends) {
      const path = entityPath(end.type, end.id)
      if (path) revalidatePath(`/${orgSlug}/${workspaceSlug}/${path}`)
    }
  } catch (error) {
    // The link is already written; a failed cache refresh must not turn it into an error.
    logFailure("revalidate", error)
  }
}
