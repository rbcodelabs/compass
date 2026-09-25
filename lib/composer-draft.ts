/**
 * Per-workspace localStorage drafts for the docked "New …" composer panels
 * (feedback, opportunity).
 *
 * A composer is a panel that can be closed (Esc, X, navigating away) or lost
 * to a reload at any moment, so every change is saved and restored on the next
 * open. Only a *successful* submit or an explicit, confirmed Discard clears it.
 *
 * This module owns the parts every composer shares: the key format, the
 * version envelope, and storage access that never throws. Each composer
 * supplies how to read its own fields back (`fromRecord`) and what counts as
 * empty. Every reader is tolerant: a hand-edited, truncated or older-format
 * value becomes "no draft", never a thrown error that breaks the panel.
 */

export type ComposerDraftStore<T> = {
  /** `compass:<kind>-draft:v<version>:<org>/<workspace>` */
  key: (orgSlug: string, workspaceSlug: string) => string
  isEmpty: (draft: T) => boolean
  /** Returns null for missing, malformed, other-version or empty values. */
  parse: (raw: string | null, now?: number) => T | null
  serialize: (draft: T) => string
  load: (key: string) => T | null
  /** Saving an empty draft removes it, so an emptied form leaves nothing behind. */
  save: (key: string, draft: T) => void
  clear: (key: string) => void
}

export function createComposerDraftStore<T extends object>({
  kind,
  version,
  isEmpty,
  fromRecord,
}: {
  kind: string
  version: number
  isEmpty: (draft: T) => boolean
  /** Rebuild a draft from an already version-checked JSON object. */
  fromRecord: (record: Record<string, unknown>, now: number) => T
}): ComposerDraftStore<T> {
  const parse = (raw: string | null, now = Date.now()): T | null => {
    if (!raw) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    if (!parsed || typeof parsed !== "object") return null
    const record = parsed as Record<string, unknown>
    if (record.version !== version) return null
    const draft = fromRecord(record, now)
    return isEmpty(draft) ? null : draft
  }

  const serialize = (draft: T) => JSON.stringify({ version, ...draft })

  return {
    key: (orgSlug, workspaceSlug) => `compass:${kind}-draft:v${version}:${orgSlug}/${workspaceSlug}`,
    isEmpty,
    parse,
    serialize,
    load(key) {
      try {
        return parse(storage()?.getItem(key) ?? null)
      } catch {
        return null
      }
    },
    save(key, draft) {
      try {
        const store = storage()
        if (!store) return
        if (isEmpty(draft)) store.removeItem(key)
        else store.setItem(key, serialize(draft))
      } catch {
        // Quota or privacy-mode failure: the in-memory draft is still intact.
      }
    },
    clear(key) {
      try {
        storage()?.removeItem(key)
      } catch {
        // Nothing useful to do — see save.
      }
    },
  }
}

/** Storage can throw (quota, privacy mode, disabled). A draft is a nicety. */
function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}

/** Reads a string field, or "" — the shape every text field in a draft uses. */
export function draftString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/** Reads a string-or-null id field. */
export function draftId(value: unknown): string | null {
  return typeof value === "string" && value ? value : null
}
