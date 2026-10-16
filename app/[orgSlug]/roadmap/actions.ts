"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { auth } from "@/auth"
import { isRoadmapViewError } from "@/lib/roadmap-views/errors"
import {
  createRoadmapView, deleteRoadmapView, resolveRoadmapViewActor, updateRoadmapView,
  type RoadmapViewRecord,
} from "@/lib/roadmap-views/service"

/**
 * Saved-view mutations for BOTH surfaces: the org-level cross-workspace roadmap
 * (`workspaceId: null`) and a single workspace's roadmap (`workspaceId` set). They
 * are plain data about how someone looks at the roadmap, not roadmap data, so a
 * read-only workspace member may keep personal views; sharing is gated separately
 * (lib/roadmap-views/access.ts). Expected failures come back as `{ ok: false }`
 * so the UI can show them; genuine faults keep throwing.
 */
export type RoadmapViewActionResult =
  | { ok: true; view: RoadmapViewRecord }
  | { ok: false; error: string }

const surfaceSchema = z.string().uuid().nullable()
const idSchema = z.string().uuid()

async function run<T>(
  orgSlug: string,
  workspaceId: unknown,
  fn: (ctx: { actor: NonNullable<Awaited<ReturnType<typeof resolveRoadmapViewActor>>>; surface: string | null }) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const session = await auth()
  if (!session?.user?.id) return { ok: false, error: "Unauthorized" }
  const surface = surfaceSchema.safeParse(workspaceId)
  if (!surface.success) return { ok: false, error: "Invalid roadmap" }
  try {
    const actor = await resolveRoadmapViewActor(session.user.id, orgSlug)
    if (!actor) return { ok: false, error: "Roadmap not found" }
    const value = await fn({ actor, surface: surface.data })
    revalidatePath(`/${orgSlug}/roadmap`)
    revalidatePath(`/${orgSlug}/[workspaceSlug]/roadmap`, "page")
    return { ok: true, value }
  } catch (error) {
    if (isRoadmapViewError(error)) return { ok: false, error: error.message }
    throw error
  }
}

export async function createRoadmapViewAction(orgSlug: string, workspaceId: string | null, input: unknown): Promise<RoadmapViewActionResult> {
  const result = await run(orgSlug, workspaceId, ({ actor, surface }) => createRoadmapView(actor, surface, input))
  return result.ok ? { ok: true, view: result.value } : result
}

export async function updateRoadmapViewAction(orgSlug: string, workspaceId: string | null, viewId: string, input: unknown): Promise<RoadmapViewActionResult> {
  if (!idSchema.safeParse(viewId).success) return { ok: false, error: "View not found" }
  const result = await run(orgSlug, workspaceId, ({ actor, surface }) => updateRoadmapView(actor, surface, viewId, input))
  return result.ok ? { ok: true, view: result.value } : result
}

export async function deleteRoadmapViewAction(orgSlug: string, workspaceId: string | null, viewId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!idSchema.safeParse(viewId).success) return { ok: false, error: "View not found" }
  const result = await run(orgSlug, workspaceId, ({ actor, surface }) => deleteRoadmapView(actor, surface, viewId))
  return result.ok ? { ok: true } : result
}
