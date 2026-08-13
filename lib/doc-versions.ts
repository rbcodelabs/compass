/**
 * Doc version snapshot logic — shared by the UI server action (updateDoc) and
 * the MCP update_doc handler so every overwriting save is captured.
 *
 * Coalescing: the 1200ms autosave debounce in the editor means a user typing
 * continuously can trigger many `updateDoc` calls in quick succession. Taking
 * a snapshot on every single one would flood the history with near-identical
 * rows. Instead we skip snapshotting when the most recent version for this
 * doc was created within the last COALESCE_WINDOW_MS by the *same author*
 * (comparing authorId, falling back to authorName when authorId is absent —
 * MCP/agent callers often have no authorId). Manual "named" snapshots
 * (opts.label set) always bypass coalescing, since a user explicitly asking
 * for a snapshot should always get one.
 */

import getPrisma from "@/lib/db"
import { Prisma } from "@prisma/client"

const COALESCE_WINDOW_MS = 5 * 60 * 1000 // 5 minutes

export interface MaybeSnapshotOptions {
  authorId?: string | null
  authorName: string
  label?: string
}

function authorKey(authorId: string | null | undefined, authorName: string): string {
  return authorId ?? authorName
}

export async function maybeSnapshotDocVersion(
  docId: string,
  opts: MaybeSnapshotOptions
): Promise<void> {
  const prisma = getPrisma()

  // Pre-change state: snapshot the doc as it currently exists, BEFORE the
  // caller applies its new title/content/metadata/icon.
  const doc = await prisma.doc.findUnique({
    where: { id: docId },
    select: { title: true, content: true, metadata: true, icon: true },
  })
  if (!doc) return

  if (!opts.label) {
    const latest = await prisma.docVersion.findFirst({
      where: { docId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, createdById: true, createdByName: true },
    })

    if (latest) {
      const withinWindow = Date.now() - latest.createdAt.getTime() < COALESCE_WINDOW_MS
      const sameAuthor =
        authorKey(latest.createdById, latest.createdByName ?? "") === authorKey(opts.authorId, opts.authorName)
      if (withinWindow && sameAuthor) return
    }
  }

  await prisma.docVersion.create({
    data: {
      docId,
      title: doc.title,
      content: doc.content,
      metadata: doc.metadata ?? undefined,
      icon: doc.icon,
      label: opts.label,
      createdById: opts.authorId ?? null,
      createdByName: opts.authorName,
    },
  })
}

export interface RestoreDocVersionOptions {
  authorId?: string | null
  authorName: string
}

/**
 * Restore a doc's live content to a previously saved version. Shared by the
 * UI's restoreDocVersion server action and the restore_doc_version MCP
 * handler so both take the same "snapshot current state first" safety step.
 * Returns null if the version or its parent doc no longer exists.
 */
export async function restoreDocVersionCore(
  versionId: string,
  opts: RestoreDocVersionOptions
): Promise<{ id: string; title: string; docId: string; restoredFrom: Date } | null> {
  const prisma = getPrisma()

  const version = await prisma.docVersion.findUnique({ where: { id: versionId } })
  if (!version) return null

  const doc = await prisma.doc.findUnique({ where: { id: version.docId }, select: { id: true } })
  if (!doc) return null

  // Snapshot the doc's CURRENT state first (uncoalesced -- always writes,
  // since a label is set) so restoring never loses the pre-restore content.
  await maybeSnapshotDocVersion(version.docId, {
    authorId: opts.authorId,
    authorName: opts.authorName,
    label: "Before restore",
  })

  const restored = await prisma.doc.update({
    where: { id: version.docId },
    data: {
      title: version.title,
      content: version.content,
      // Explicit Prisma.JsonNull (not JS undefined) so a version with no
      // metadata actually clears the doc's current metadata on restore,
      // rather than leaving it untouched.
      metadata: version.metadata === null ? Prisma.JsonNull : (version.metadata as Prisma.InputJsonValue),
      icon: version.icon,
      updatedAt: new Date(),
    },
  })

  return { id: restored.id, title: restored.title, docId: version.docId, restoredFrom: version.createdAt }
}
