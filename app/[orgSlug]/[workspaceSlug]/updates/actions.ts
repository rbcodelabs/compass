"use server";
import getPrisma from "@/lib/db";
import { requireWorkspaceContext } from "@/lib/workspace-context";
import {
  getUpdatesPage,
  markUpdatesCaughtUp,
  undoUpdatesCaughtUp,
} from "@/lib/workspace-updates";

export async function loadUpdates(
  orgSlug: string,
  workspaceSlug: string,
  mode: "unread" | "week",
  cursor?: string,
) {
  const ctx = await requireWorkspaceContext(orgSlug, workspaceSlug);
  if (mode !== "unread" && mode !== "week")
    throw new Error("Invalid update period");
  return getUpdatesPage(
    getPrisma(),
    ctx.workspace.id,
    ctx.userId,
    `/${encodeURIComponent(orgSlug)}/${encodeURIComponent(workspaceSlug)}`,
    mode,
    cursor,
  );
}
export async function markCaughtUp(
  orgSlug: string,
  workspaceSlug: string,
  token: string,
) {
  const ctx = await requireWorkspaceContext(orgSlug, workspaceSlug);
  try {
    const result = await markUpdatesCaughtUp(
      getPrisma(),
      ctx.workspace.id,
      ctx.userId,
      token,
    );
    return { ok: true as const, ...result };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Catch-up changed in another tab")
    )
      return { ok: false as const, error: error.message };
    throw error;
  }
}
export async function undoCaughtUp(
  orgSlug: string,
  workspaceSlug: string,
  receipt: string,
) {
  const ctx = await requireWorkspaceContext(orgSlug, workspaceSlug);
  try {
    const result = await undoUpdatesCaughtUp(
      getPrisma(),
      ctx.workspace.id,
      ctx.userId,
      receipt,
    );
    return { ok: true as const, ...result };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Catch-up changed in another tab")
    ) {
      return { ok: false as const, error: error.message };
    }
    throw error;
  }
}
