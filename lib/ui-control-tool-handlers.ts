/**
 * MCP tools for agent control of the user's live UI:
 * ui_navigate, ui_screenshot, ui_get_state.
 *
 * Each call acts on the *calling user's* opted-in browser tab in the given
 * workspace and waits briefly for the tab to answer. All failure modes (no
 * opt-in, tab asleep, refused path) come back as `fail()` text the agent can
 * act on, not as thrown errors.
 */

import getPrisma from "@/lib/db"
import { getMcpActor } from "@/lib/mcp-authz"
import { fail, ok, type ToolResult } from "@/lib/mcp-output"
import { workspaceBasePath } from "@/lib/entity-links"
import { resolveNavigationPath, runUiCommand, UiControlError, UI_SCREENSHOT_MAX_BASE64 } from "@/lib/ui-control"

type WorkspaceArgs = { workspaceId: string }

async function withUserCommand(
  workspaceId: string,
  run: (userId: string) => Promise<ToolResult>,
): Promise<ToolResult> {
  const actor = getMcpActor()
  if (!actor.userId) {
    return fail("UI control needs a user identity: the shared service key has no browser to drive.")
  }
  try {
    return await run(actor.userId)
  } catch (error) {
    if (error instanceof UiControlError) return fail(error.message, { code: error.code, workspaceId })
    throw error
  }
}

export async function uiNavigate({ workspaceId, path }: WorkspaceArgs & { path: string }): Promise<ToolResult> {
  return withUserCommand(workspaceId, async (userId) => {
    const prisma = getPrisma()
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { slug: true, organization: { select: { slug: true } } },
    })
    if (!workspace?.organization) return fail("Workspace not found.")
    const basePath = workspaceBasePath({ orgSlug: workspace.organization.slug, workspaceSlug: workspace.slug })
    const resolved = resolveNavigationPath(path, basePath)
    const result = (await runUiCommand({ prisma, userId, workspaceId, kind: "navigate", commandArgs: { path: resolved } })) as {
      path?: string
      title?: string
    } | null
    return ok(`Moved the user to ${result?.path ?? resolved}.`, { path: result?.path ?? resolved, title: result?.title ?? null })
  })
}

export async function uiGetState({ workspaceId }: WorkspaceArgs): Promise<ToolResult> {
  return withUserCommand(workspaceId, async (userId) => {
    const state = (await runUiCommand({ prisma: getPrisma(), userId, workspaceId, kind: "get_state" })) as Record<string, unknown> | null
    return ok("Current screen state of the user's tab.", state ?? {})
  })
}

export async function uiScreenshot({ workspaceId }: WorkspaceArgs): Promise<ToolResult> {
  return withUserCommand(workspaceId, async (userId) => {
    const result = (await runUiCommand({ prisma: getPrisma(), userId, workspaceId, kind: "screenshot" })) as {
      pngBase64?: string
      path?: string
      width?: number
      height?: number
    } | null
    const png = result?.pngBase64
    if (!png || png.length > UI_SCREENSHOT_MAX_BASE64 || !/^[A-Za-z0-9+/=]+$/.test(png)) {
      return fail("The browser returned no usable screenshot.")
    }
    const meta = { path: result?.path ?? null, width: result?.width ?? null, height: result?.height ?? null }
    const text = `Screenshot of what the user sees${meta.path ? ` at ${meta.path}` : ""}. Captured client-side, so cross-origin images and canvases may be blank.`
    return {
      content: [
        { type: "image", data: png, mimeType: "image/png" },
        { type: "text", text },
      ],
      structuredContent: { ok: true, message: text, data: meta },
    } as unknown as ToolResult
  })
}
