"use server"

import { z } from "zod"
import {
  createSavedViewAction, deleteSavedViewAction, updateSavedViewAction,
} from "@/app/[orgSlug]/saved-views-actions"
import type { RoadmapViewRecord } from "@/lib/roadmap-views/service"
import { roadmapSurfaceFor } from "@/lib/saved-views/surfaces"

/**
 * Saved-view mutations for BOTH roadmap surfaces: the org-level cross-workspace
 * roadmap (`workspaceId: null`) and a single workspace's roadmap (`workspaceId` set).
 * A thin compatibility layer over the generalized actions in
 * app/[orgSlug]/saved-views-actions.ts, kept for one release so the Roadmap UI keeps
 * its call signatures. Expected failures come back as `{ ok: false }`.
 */
export type RoadmapViewActionResult =
  | { ok: true; view: RoadmapViewRecord }
  | { ok: false; error: string }

const workspaceIdSchema = z.string().uuid().nullable()

export async function createRoadmapViewAction(orgSlug: string, workspaceId: string | null, input: unknown): Promise<RoadmapViewActionResult> {
  if (!workspaceIdSchema.safeParse(workspaceId).success) return { ok: false, error: "Invalid roadmap" }
  return (await createSavedViewAction(orgSlug, roadmapSurfaceFor(workspaceId), workspaceId, input)) as RoadmapViewActionResult
}

export async function updateRoadmapViewAction(
  orgSlug: string, workspaceId: string | null, viewId: string, input: unknown, expectedUpdatedAt?: string,
): Promise<RoadmapViewActionResult> {
  if (!workspaceIdSchema.safeParse(workspaceId).success) return { ok: false, error: "Invalid roadmap" }
  return (await updateSavedViewAction(orgSlug, roadmapSurfaceFor(workspaceId), workspaceId, viewId, input, expectedUpdatedAt)) as RoadmapViewActionResult
}

export async function deleteRoadmapViewAction(orgSlug: string, workspaceId: string | null, viewId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!workspaceIdSchema.safeParse(workspaceId).success) return { ok: false, error: "Invalid roadmap" }
  return deleteSavedViewAction(orgSlug, roadmapSurfaceFor(workspaceId), workspaceId, viewId)
}
