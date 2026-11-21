import { createHash } from "node:crypto"
import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { getArtifactStorage } from "@/lib/artifact-storage"
import { isPermissionError, resolveOrgAdmin } from "@/lib/permissions"
import { defaultBlobAdapters } from "@/lib/workspace-export/blobs"
import { WorkspaceImportError, WorkspaceImportRecoveryRequired, importWorkspaceBundle } from "@/lib/workspace-export/import"
import { MAX_BUNDLE_BYTES, loadStagedBundle, verifyBundleReceipt } from "@/lib/workspace-export/upload"
import { bindImportReceipt, readImportReceiptResult } from "@/lib/workspace-export/receipt-binding"

import { commitImportReport, startImportOperation, type ImportDatabase } from "@/lib/workspace-export/operation"
import type { ImportLeaseOwner } from "@/lib/workspace-export/lease"

export const maxDuration = 300

/**
 * Imports a bundle as a NEW workspace in the organization. Org admins only.
 *   multipart/form-data: file, name?, slug?, nonce?
 *   application/json:    { receipt, name?, slug?, nonce? }   (receipt from /prepare after a direct upload)
 * Retrying with the same nonce resumes/returns the same import instead of creating a second copy.
 */
export async function POST(req: Request, { params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  let organizationId: string
  let prisma: Awaited<ReturnType<typeof resolveOrgAdmin>>["prisma"]
  try {
    ;({ organizationId, prisma } = await resolveOrgAdmin(orgSlug))
  } catch (error) {
    if (isPermissionError(error)) {
      const status = error.message === "Unauthorized" ? 401 : error.message.startsWith("Forbidden") ? 403 : 404
      return NextResponse.json({ error: error.message }, { status })
    }
    throw error
  }
  const session = await auth()
  const userId = session!.user!.id!

  let receiptBinding: Omit<Parameters<typeof bindImportReceipt>[1], "workspaceId"> | undefined
  let owner: ImportLeaseOwner | undefined
  let bytes: Uint8Array
  let discard: (() => Promise<void>) | undefined
  let fields: { name?: string; slug?: string; nonce?: string } = {}
  try {
    if ((req.headers.get("content-type") ?? "").includes("application/json")) {
      const body = (await req.json()) as { receipt?: string; name?: string; slug?: string; nonce?: string }
      if (!body.receipt) return NextResponse.json({ error: "receipt is required" }, { status: 400 })
      const verified = verifyBundleReceipt(body.receipt, organizationId, userId, Date.now(), "replay")
      const nonce = body.nonce ?? verified.uploadId
      const digest = createHash("sha256").update(JSON.stringify(["workspace-import", organizationId, userId, verified.uploadId])).digest("hex")
      const result = await readImportReceiptResult(prisma, { organizationId, userId, nonce, digest })
      if (result) return NextResponse.json({ ok: true, ...result })
      const staged = await loadStagedBundle(body.receipt, organizationId, userId, getArtifactStorage())
      bytes = staged.bytes
      discard = staged.discard
      fields = { ...body, nonce }
      receiptBinding = { organizationId, userId, nonce, digest, expiresAt: new Date(verified.replayExpiresAt ?? verified.expiresAt) }
    } else {
      const form = await req.formData()
      const file = form.get("file")
      if (!(file instanceof File)) return NextResponse.json({ error: "A bundle file is required" }, { status: 400 })
      if (file.size > MAX_BUNDLE_BYTES) return NextResponse.json({ error: "The bundle exceeds the 512 MB limit" }, { status: 413 })
      bytes = new Uint8Array(await file.arrayBuffer())
      const str = (k: string) => (typeof form.get(k) === "string" && String(form.get(k)).trim() ? String(form.get(k)).trim() : undefined)
      fields = { name: str("name"), slug: str("slug"), nonce: str("nonce") }
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not read the bundle" }, { status: 400 })
  }

  try {
    const report = await importWorkspaceBundle(prisma, bytes, {
      organizationId,
      importerUserId: userId,
      name: fields.name,
      slug: fields.slug,
      nonce: fields.nonce,
      blobs: defaultBlobAdapters(),
      async bindWorkspace(workspaceId) {
        if (receiptBinding) await bindImportReceipt(prisma, { ...receiptBinding, workspaceId })
      },
      async recordExisting(report) {
        if (!receiptBinding) return
        const binding = receiptBinding
        await prisma.$transaction(async (tx) => {
          if (await readImportReceiptResult(tx, binding)) return
          const workspace = await tx.workspace.findFirst({ where: { id: report.workspaceId, organizationId }, select: { id: true } })
          if (!workspace) throw new WorkspaceImportRecoveryRequired("Imported workspace is unavailable")
          const existingOwner = await startImportOperation(tx, workspace.id, organizationId)
          await commitImportReport(tx, existingOwner, report)
        })
      },
      async startOperation(workspaceId) {
        owner = await startImportOperation(prisma, workspaceId, organizationId)
      },
      async publishResult(tx, report) {
        if (!owner) throw new Error("Missing workspace import owner")
        await commitImportReport(tx as ImportDatabase, owner, report)
      },
    })
    await discard?.()
    const { revalidatePath } = await import("next/cache")
    revalidatePath("/dashboard")
    revalidatePath("/", "layout")
    return NextResponse.json({ ok: true, ...report })
  } catch (error) {
    if (error instanceof WorkspaceImportError) return NextResponse.json({ error: error.message }, { status: 422 })
    if (error instanceof WorkspaceImportRecoveryRequired) return NextResponse.json({ error: error.message }, { status: 503 })
    console.error("[workspace-import] failed", error)
    return NextResponse.json({ error: "The import could not be completed. Retry with the same import identity." }, { status: 500 })
  }
}
