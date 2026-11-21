import getPrisma from "@/lib/db"
import { hydrateDocument } from "@/lib/document-service"

export type DocVersionStatus = { number: number; editedSince: boolean }

/**
 * Has the doc changed since a decision-pinned version? Compares the pinned version title and body with the
 * doc as it is right now (the caller already holds the hydrated current doc), so an edit that was later
 * reverted does not count as edited.
 *
 * Returns null when the answer is unknown (version missing, belongs to another doc, or its body cannot be read);
 * callers show the version number without an edited-since claim rather than guessing.
 * Call only after authorizing access to the workspace and document.
 */
export async function getDocVersionStatus(
  workspaceId: string,
  docId: string,
  version: { id: string; number: number },
  current: { title: string; content: string | null },
): Promise<DocVersionStatus | null> {
  try {
    const row = await getPrisma().docVersion.findFirst({
      where: { id: version.id, docId },
      select: { title: true, content: true, storageProvider: true, contentRef: true },
    })
    if (!row) return null
    const pinned = await hydrateDocument(workspaceId, row)
    const same = pinned.title === current.title && (pinned.content ?? "") === (current.content ?? "")
    return { number: version.number, editedSince: !same }
  } catch {
    return null
  }
}
