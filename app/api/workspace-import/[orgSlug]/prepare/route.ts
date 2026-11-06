import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { isPermissionError, resolveOrgAdmin } from "@/lib/permissions"
import { MAX_BUNDLE_BYTES, MAX_MULTIPART_BYTES, directUploadAvailable, prepareBundleUpload } from "@/lib/workspace-export/upload"

/** Tells the client how to upload a bundle: directly to Blob (large files) or through the multipart route. */
export async function POST(req: Request, { params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  try {
    const { organizationId } = await resolveOrgAdmin(orgSlug)
    const session = await auth()
    const body = (await req.json().catch(() => ({}))) as { fileSize?: number }
    const fileSize = Number(body.fileSize)
    if (!Number.isInteger(fileSize) || fileSize < 1) return NextResponse.json({ error: "fileSize is required" }, { status: 400 })
    if (fileSize > MAX_BUNDLE_BYTES) return NextResponse.json({ error: "The bundle exceeds the 512 MB limit" }, { status: 413 })
    if (!directUploadAvailable()) {
      if (fileSize > MAX_MULTIPART_BYTES && process.env.VERCEL) {
        return NextResponse.json({ error: "Direct upload is not configured for this deployment" }, { status: 503 })
      }
      return NextResponse.json({ mode: "multipart" })
    }
    const prepared = await prepareBundleUpload({ organizationId, userId: session!.user!.id!, fileSize })
    return NextResponse.json({ mode: "direct", ...prepared })
  } catch (error) {
    if (isPermissionError(error)) {
      const status = error.message === "Unauthorized" ? 401 : error.message.startsWith("Forbidden") ? 403 : 404
      return NextResponse.json({ error: error.message }, { status })
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not prepare upload" }, { status: 400 })
  }
}
