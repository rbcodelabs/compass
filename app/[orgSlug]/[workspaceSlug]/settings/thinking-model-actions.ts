"use server"

/**
 * Workspace thinking-model settings (preset key + label overrides).
 *
 * ## Why workspace admin
 *
 * Changing the model renames entities in every member's UI, so it is an admin
 * action (ADR "Thinking-model presets", point 17). It uses resolveWorkspaceAdmin,
 * which admits workspace ADMINs and org admins who are also workspace members.
 * It deliberately does NOT copy the membership-only pattern of the neighbouring
 * toggles in settings/actions.ts (a known gap, tracked as a follow-up).
 *
 * ## What it trusts
 *
 * Only the two slugs, which resolveWorkspaceAdmin turns into a workspace id the
 * caller is authorized for. The input is a strict schema, so a client-supplied
 * workspace id is rejected rather than ignored. It always writes an explicit key,
 * never NULL (NULL is reserved for "never chosen", which means CLASSIC).
 *
 * Presentation only: no data or links change, and nothing server-side branches
 * on the stored preset.
 */

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { isPermissionError, resolveWorkspaceAdmin } from "@/lib/permissions"
import { PICKABLE_THINKING_MODEL_KEYS, THINKING_MODEL_KEYS } from "@/lib/thinking-model/presets"
import { validateLabelOverrides } from "@/lib/thinking-model/validate"

export type UpdateThinkingModelResult = { ok: true; thinkingModel: string } | { ok: false; error: string }

const inputSchema = z.strictObject({
  thinkingModel: z.enum(THINKING_MODEL_KEYS),
  labels: z.unknown().optional(),
})

export async function updateThinkingModel(
  orgSlug: string,
  workspaceSlug: string,
  input: unknown,
): Promise<UpdateThinkingModelResult> {
  try {
    const { prisma, workspaceId } = await resolveWorkspaceAdmin(orgSlug, workspaceSlug)

    const parsed = inputSchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: "Choose a valid thinking model." }

    const previous = await prisma.workspace.findFirst({
      where: { id: workspaceId },
      select: { thinkingModel: true },
    })
    // A preset that is defined but not offered yet (see PICKABLE_THINKING_MODEL_KEYS)
    // cannot be newly chosen; a workspace already on it may keep saving.
    const offered = (PICKABLE_THINKING_MODEL_KEYS as readonly string[]).includes(parsed.data.thinkingModel)
    if (!offered && previous?.thinkingModel !== parsed.data.thinkingModel) {
      return { ok: false, error: "That thinking model is not available yet." }
    }

    const labels = validateLabelOverrides(parsed.data.labels ?? {}, parsed.data.thinkingModel)
    if (!labels.ok) return { ok: false, error: labels.error }

    const hasLabels = Object.keys(labels.value).length > 0

    await prisma.workspace.update({
      where: { id: workspaceId },
      data: {
        thinkingModel: parsed.data.thinkingModel,
        thinkingModelLabels: hasLabels ? JSON.stringify(labels.value) : null,
      },
    })

    // No label contents: they are user text, and the ids and keys are the audit trail.
    console.info(
      JSON.stringify({
        event: "workspace.thinking_model.updated",
        workspaceId,
        previousKey: previous?.thinkingModel ?? null,
        newKey: parsed.data.thinkingModel,
      }),
    )

    revalidatePath(`/${orgSlug}/${workspaceSlug}`, "layout")
    return { ok: true, thinkingModel: parsed.data.thinkingModel }
  } catch (error) {
    if (isPermissionError(error)) return { ok: false, error: error.message }
    // Name and code only: Prisma errors can echo the failing row, which holds label text.
    const e = error as { name?: string; code?: string }
    console.error("[thinking-model] update failed", { name: e?.name, code: e?.code })
    return { ok: false, error: "Something went wrong. Please try again." }
  }
}
