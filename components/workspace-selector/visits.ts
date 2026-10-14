"use client"

import { useCallback, useSyncExternalStore } from "react"
import type { VisitLog } from "./model"

/**
 * Per-browser record of when each workspace was last opened. There is no
 * per-user "last visited" column in the database, so recents live in
 * localStorage: no migration, no extra round trip, and a cleared browser just
 * means an empty "Jump back in" row.
 */
const STORAGE_KEY = "compass:workspace-visits"
/** Browsers are shared between accounts; scoping by user keeps one person's history off another's gallery. */
const storageKeyFor = (scope?: string) => (scope ? `${STORAGE_KEY}:${scope.toLowerCase()}` : STORAGE_KEY)
const MAX_ENTRIES = 50
const EMPTY: VisitLog = Object.freeze({}) as VisitLog

let cachedKey: string | undefined
let cachedRaw: string | null | undefined
let cachedLog: VisitLog = EMPTY
const listeners = new Set<() => void>()

function readRaw(storageKey: string): string | null {
  try {
    return window.localStorage.getItem(storageKey)
  } catch {
    return null
  }
}

function parse(raw: string | null): VisitLog {
  if (!raw) return EMPTY
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY
    const out: VisitLog = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v
    }
    return out
  } catch {
    return EMPTY
  }
}

/** Snapshot must be referentially stable between changes for useSyncExternalStore. */
function getSnapshot(storageKey: string): VisitLog {
  const raw = readRaw(storageKey)
  if (storageKey !== cachedKey || raw !== cachedRaw) {
    cachedKey = storageKey
    cachedRaw = raw
    cachedLog = parse(raw)
  }
  return cachedLog
}

function subscribe(storageKey: string, listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (e: StorageEvent) => {
    if (e.key === storageKey || e.key === null) listener()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

export function recordWorkspaceVisit(key: string, now: number = Date.now(), scope?: string): void {
  const storageKey = storageKeyFor(scope)
  const next: VisitLog = { ...getSnapshot(storageKey), [key]: now }
  const entries = Object.entries(next).sort((a, b) => b[1] - a[1]).slice(0, MAX_ENTRIES)
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    return // storage unavailable (private mode / quota): recents are best-effort
  }
  listeners.forEach((l) => l())
}

/** Returns an empty log on the server and during hydration, then the stored one. */
export function useWorkspaceVisits(scope?: string): VisitLog {
  const storageKey = storageKeyFor(scope)
  const sub = useCallback((listener: () => void) => subscribe(storageKey, listener), [storageKey])
  const snap = useCallback(() => getSnapshot(storageKey), [storageKey])
  return useSyncExternalStore(sub, snap, () => EMPTY)
}
