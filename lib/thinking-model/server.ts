import { getWorkspaceContext } from "@/lib/workspace-context"
import { CLASSIC_THINKING_MODEL, resolveThinkingModel, type ResolvedThinkingModel } from "./resolve"

/**
 * The thinking model for a workspace URL, for server code that has no workspace
 * object in hand (chiefly `generateMetadata`, which cannot see the layout's
 * context). getWorkspaceContext is wrapped in React's cache(), and the workspace
 * layout calls it with the same arguments first, so this costs no extra query.
 *
 * Falls back to CLASSIC when there is no authorized workspace: a metadata title
 * must never throw or reveal anything about a workspace the caller cannot see.
 */
export async function getThinkingModelForSlugs(
  orgSlug: string,
  workspaceSlug: string,
): Promise<ResolvedThinkingModel> {
  const ctx = await getWorkspaceContext(orgSlug, workspaceSlug)
  return ctx.status === "ok" ? resolveThinkingModel(ctx.workspace) : CLASSIC_THINKING_MODEL
}
