"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { auth } from "@/auth"
import { isSavedViewError } from "@/lib/saved-views/errors"
import {
  createSavedView, deleteSavedView, resolveSavedViewActor, updateSavedView, type SavedViewRecord,
} from "@/lib/saved-views/service"
import { SAVED_VIEW_SURFACES, SURFACES, isConsistentScope, type SavedViewSurface } from "@/lib/saved-views/surfaces"

/**
 * Saved-view mutations for EVERY surface (Opportunities board, Solutions board and
 * both roadmaps). They are plain data about how someone looks at a page, not the
 * page's data, so a read-only workspace member may keep personal views; sharing is
 * gated separately (lib/saved-views/access.ts, and per surface in surfaces.ts).
 * Expected failures come back as `{ ok: false }` so the UI can show them; genuine
 * faults keep throwing.
 */
export type SavedViewActionResult =
  | { ok: true; view: SavedViewRecord }
  | { ok: false; error: string; code?: string }

const surfaceSchema = z.enum(SAVED_VIEW_SURFACES)
const workspaceIdSchema = z.string().uuid().nullable()
const idSchema = z.string().uuid()

function pathsToRevalidate(orgSlug: string, surface: SavedViewSurface): Array<[string] | [string, "page"]> {
  switch (surface) {
    // Both roadmap pages read views, and this is what the roadmap actions always did.
    case "ROADMAP_ORG":
    case "ROADMAP_WORKSPACE": return [[`/${orgSlug}/roadmap`], [`/${orgSlug}/[workspaceSlug]/roadmap`, "page"]]
    case "OPPORTUNITIES_BOARD": return [[`/${orgSlug}/[workspaceSlug]/discovery`, "page"]]
    case "SOLUTIONS_BOARD": return [[`/${orgSlug}/[workspaceSlug]/solutions`, "page"]]
  }
}

async function run<T>(
  orgSlug: string,
  surfaceInput: unknown,
  workspaceIdInput: unknown,
  fn: (ctx: { actor: NonNullable<Awaited<ReturnType<typeof resolveSavedViewActor>>>; surface: SavedViewSurface; workspaceId: string | null }) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string; code?: string }> {
  const session = await auth()
  if (!session?.user?.id) return { ok: false, error: "Unauthorized" }
  const surface = surfaceSchema.safeParse(surfaceInput)
  const workspaceId = workspaceIdSchema.safeParse(workspaceIdInput)
  if (!surface.success || !workspaceId.success || !isConsistentScope(surface.data, workspaceId.data)) {
    return { ok: false, error: "Invalid view location" }
  }
  try {
    const actor = await resolveSavedViewActor(session.user.id, orgSlug)
    if (!actor) return { ok: false, error: `${SURFACES[surface.data].label.charAt(0).toUpperCase()}${SURFACES[surface.data].label.slice(1)} not found` }
    const value = await fn({ actor, surface: surface.data, workspaceId: workspaceId.data })
    for (const [path, type] of pathsToRevalidate(orgSlug, surface.data)) {
      if (type) revalidatePath(path, type)
      else revalidatePath(path)
    }
    return { ok: true, value }
  } catch (error) {
    if (isSavedViewError(error)) {
      // Only CONFLICT carries a code: the UI offers a reload for it, and every other failure keeps its historical shape.
      if (error.code === "CONFLICT") return { ok: false, error: error.message, code: error.code }
      return { ok: false, error: error.message }
    }
    throw error
  }
}

export async function createSavedViewAction(orgSlug: string, surface: SavedViewSurface, workspaceId: string | null, input: unknown): Promise<SavedViewActionResult> {
  const result = await run(orgSlug, surface, workspaceId, (ctx) => createSavedView(ctx.actor, ctx.surface, ctx.workspaceId, input))
  return result.ok ? { ok: true, view: result.value } : result
}

/** `expectedUpdatedAt` is the view's `updatedAt` as the caller last saw it; a mismatch fails instead of overwriting. */
export async function updateSavedViewAction(
  orgSlug: string, surface: SavedViewSurface, workspaceId: string | null, viewId: string, input: unknown, expectedUpdatedAt?: string,
): Promise<SavedViewActionResult> {
  if (!idSchema.safeParse(viewId).success) return { ok: false, error: "View not found" }
  const result = await run(orgSlug, surface, workspaceId, (ctx) => updateSavedView(ctx.actor, ctx.surface, ctx.workspaceId, viewId, input, expectedUpdatedAt))
  return result.ok ? { ok: true, view: result.value } : result
}

export async function deleteSavedViewAction(orgSlug: string, surface: SavedViewSurface, workspaceId: string | null, viewId: string): Promise<{ ok: true } | { ok: false; error: string; code?: string }> {
  if (!idSchema.safeParse(viewId).success) return { ok: false, error: "View not found" }
  const result = await run(orgSlug, surface, workspaceId, (ctx) => deleteSavedView(ctx.actor, ctx.surface, ctx.workspaceId, viewId))
  return result.ok ? { ok: true } : result
}
