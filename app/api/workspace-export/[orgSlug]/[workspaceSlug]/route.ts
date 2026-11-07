import { NextResponse } from "next/server"
import { isPermissionError, resolveWorkspaceAdmin } from "@/lib/permissions"
import { defaultBlobAdapters } from "@/lib/workspace-export/blobs"
import { WorkspaceExportRefusal, exportWorkspaceStream } from "@/lib/workspace-export/export"

export const maxDuration = 300

/** Streams a portable workspace bundle (zip). Workspace admins and org admins only. */
export async function GET(_req: Request, { params }: { params: Promise<{ orgSlug: string; workspaceSlug: string }> }) {
  const { orgSlug, workspaceSlug } = await params
  let scope
  try {
    scope = await resolveWorkspaceAdmin(orgSlug, workspaceSlug)
  } catch (error) {
    if (isPermissionError(error)) {
      const status = error.message === "Unauthorized" ? 401 : error.message.startsWith("Forbidden") ? 403 : 404
      return NextResponse.json({ error: error.message }, { status })
    }
    throw error
  }
  try {
    // Fail before streaming starts if the workspace cannot be exported.
    const stream = exportWorkspaceStream(scope.prisma, scope.workspaceId, defaultBlobAdapters())
    const date = new Date().toISOString().slice(0, 10)
    return new Response(stream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${workspaceSlug}-${date}.compass.zip"`,
        "Cache-Control": "no-store",
      },
    })
  } catch (error) {
    if (error instanceof WorkspaceExportRefusal) return NextResponse.json({ error: error.message }, { status: 422 })
    throw error
  }
}
