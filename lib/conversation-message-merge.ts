/** Folds edits made elsewhere into the transcript a tab already shows (TASK-195 S1). Pure, so it is testable on its own. */

type Mergeable = { id: string; content: string; editedAt?: string | null; canEdit?: boolean }

/**
 * For each incoming message this tab already has, adopt the text, edit time and capability when the server reports a
 * newer edit. Order and every untouched row keep their identity; the same array comes back when nothing changed.
 */
export function refreshEditedMessages<T extends Mergeable>(current: T[], incoming: T[]): T[] {
  const byId = new Map(incoming.map((m) => [m.id, m]))
  let changed = false
  const next = current.map((m) => {
    const update = byId.get(m.id)
    if (!update?.editedAt || update.editedAt === m.editedAt) return m
    changed = true
    return { ...m, content: update.content, editedAt: update.editedAt, canEdit: update.canEdit }
  })
  return changed ? next : current
}
