import type { NotificationPage } from "@/lib/notifications"
import { notificationAction, subjectTypeLabel } from "@/lib/notification-text"

/**
 * Serializable view model for the inbox page: dates as ISO strings, the sentence
 * already built, the subject resolved to a link. Built on the server from the
 * access-checked NotificationPage, so the client component never sees a title
 * for a subject the viewer cannot open.
 */
export type InboxItem = {
  id: string
  sentence: string
  actorName: string
  action: string
  read: boolean
  createdAt: string
}

export type InboxGroup = {
  key: string
  subjectType: string
  subjectLabel: string
  /** Null when the subject was deleted or is not visible to the viewer. */
  title: string | null
  href: string | null
  unreadCount: number
  latestAt: string
  items: InboxItem[]
}

export function toInboxGroups(page: NotificationPage, basePath: string): InboxGroup[] {
  return page.groups.map((group) => ({
    key: `${group.subjectType}:${group.subjectId}`,
    subjectType: group.subjectType,
    subjectLabel: subjectTypeLabel(group.subjectType),
    title: group.subject?.title ?? null,
    href: group.subject ? `${basePath}/${group.subject.path}` : null,
    unreadCount: group.unreadCount,
    latestAt: group.latestAt.toISOString(),
    items: group.items.map((item) => ({
      id: item.id,
      actorName: item.actor.name,
      action: notificationAction({ kind: item.kind, payload: item.payload }),
      sentence: `${item.actor.name} ${notificationAction({ kind: item.kind, payload: item.payload })}`,
      read: item.read,
      createdAt: item.createdAt.toISOString(),
    })),
  }))
}
