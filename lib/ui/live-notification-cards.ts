import type { LiveNotificationAlert } from "@/lib/notifications"

/**
 * Module-level external store (`useSyncExternalStore`-compatible) for the
 * top-right Studio Quiet live notification card stack. Newest card sits at
 * index 0 (top of the 3D triage deck), capped at MAX_LIVE_CARDS.
 */
export const MAX_LIVE_CARDS = 6

export type LiveNotificationCard = LiveNotificationAlert & {
  orgSlug: string
  workspaceSlug: string
}

type Listener = () => void

const listeners = new Set<Listener>()
export const EMPTY_LIVE_CARDS: readonly LiveNotificationCard[] = []
let cards: readonly LiveNotificationCard[] = EMPTY_LIVE_CARDS

function emit(): void {
  for (const listener of listeners) listener()
}

export function pushLiveNotificationCard(card: LiveNotificationCard): string {
  if (cards.some((existing) => existing.id === card.id)) {
    return card.id
  }
  cards = [card, ...cards].slice(0, MAX_LIVE_CARDS)
  emit()
  return card.id
}

export function dismissLiveNotificationCard(id: string): void {
  const next = cards.filter((card) => card.id !== id)
  if (next.length === cards.length) return
  cards = next.length === 0 ? EMPTY_LIVE_CARDS : next
  emit()
}

export function clearLiveNotificationCards(scope?: { orgSlug: string; workspaceSlug: string }): void {
  if (cards.length === 0) return
  if (!scope) {
    cards = EMPTY_LIVE_CARDS
    emit()
    return
  }
  const next = cards.filter(
    (card) => card.orgSlug !== scope.orgSlug || card.workspaceSlug !== scope.workspaceSlug,
  )
  if (next.length === cards.length) return
  cards = next.length === 0 ? EMPTY_LIVE_CARDS : next
  emit()
}

export function subscribeLiveNotificationCards(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getLiveNotificationCards(): readonly LiveNotificationCard[] {
  return cards
}

/** Test helper: drop every live card and notify listeners. */
export function resetLiveNotificationCards(): void {
  cards = EMPTY_LIVE_CARDS
  emit()
}
