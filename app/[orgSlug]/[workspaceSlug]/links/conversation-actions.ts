"use server"

/**
 * UI actions behind the "Conversations" section on an Opportunity, Solution or Task (RM-19). Nothing here trusts the client:
 *
 *  - The workspace comes from the slug pair WITH the caller's membership in the same query (requireProductWorkspaceBySlug). Membership is
 *    the write access for conversation links, so a read-only org viewer gets an empty section and cannot remove anything.
 *  - Reads return only conversations this viewer may open (lib/agent-conversation-access.ts); the rest are omitted entirely.
 *  - A removal also requires access to the conversation. An unknown, foreign or inaccessible link answers like a missing one.
 */
import { revalidatePath } from "next/cache"
import { z } from "zod"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { listConversationsForObject, removeConversationLink, type ObjectConversationLink } from "@/lib/links/conversation-links"
import { requireProductWorkspaceBySlug } from "@/lib/product-action-auth"

export type ReadObjectConversationsResult = { ok: true; items: ObjectConversationLink[] } | { ok: false; error: string }
export type RemoveConversationLinkResult = { ok: true; removed: boolean } | { ok: false; error: string }

const DENIED = "Not found or access denied"
const scope = z.object({ orgSlug: z.string().trim().min(1).max(255), workspaceSlug: z.string().trim().min(1).max(255) })
const target = z.object({ entityType: z.enum(["OPPORTUNITY", "SOLUTION", "TASK"]), entityId: z.string().uuid() })

async function authorize(orgSlug: string, workspaceSlug: string): Promise<{ workspaceId: string; userId: string } | null> {
  const parsed = scope.safeParse({ orgSlug, workspaceSlug })
  if (!parsed.success) return null
  try {
    const workspaceId = await requireProductWorkspaceBySlug(parsed.data.orgSlug, parsed.data.workspaceSlug)
    const userId = (await auth())?.user?.id
    return userId ? { workspaceId, userId } : null
  } catch {
    return null
  }
}

export async function readObjectConversations(orgSlug: string, workspaceSlug: string, input: { entityType: string; entityId: string }): Promise<ReadObjectConversationsResult> {
  const parsed = target.safeParse(input)
  if (!parsed.success) return { ok: false, error: DENIED }
  const who = await authorize(orgSlug, workspaceSlug)
  if (!who) return { ok: false, error: DENIED }
  try {
    return { ok: true, items: await listConversationsForObject(getPrisma(), { ...parsed.data, workspaceId: who.workspaceId, userId: who.userId }) }
  } catch {
    return { ok: false, error: "Could not load conversations." }
  }
}

export async function removeObjectConversationLink(orgSlug: string, workspaceSlug: string, linkId: string): Promise<RemoveConversationLinkResult> {
  const id = z.string().uuid().safeParse(linkId)
  if (!id.success) return { ok: false, error: DENIED }
  const who = await authorize(orgSlug, workspaceSlug)
  if (!who) return { ok: false, error: DENIED }
  try {
    const removed = await removeConversationLink(getPrisma(), { linkId: id.data, workspaceId: who.workspaceId, userId: who.userId })
    if (removed) revalidatePath(`/${orgSlug}/${workspaceSlug}`, "layout")
    return { ok: true, removed }
  } catch {
    return { ok: false, error: "Could not remove the link. Please try again." }
  }
}
