"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { BellOff, CheckCheck } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { NOTIFICATIONS_CHANGED_EVENT } from "@/components/notifications/notification-bell"
import { useLabels } from "@/components/thinking-model/thinking-model-provider"
import type { InboxGroup } from "@/lib/notification-inbox"

function formatWhen(iso: string): string {
  // UTC on purpose, like the Updates feed: identical text on the server and in the browser.
  return `${new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" })} UTC`
}

async function postRead(orgSlug: string, workspaceSlug: string, body: { ids: string[] } | { all: true }): Promise<boolean> {
  try {
    const response = await fetch("/api/notifications/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgSlug, workspaceSlug, ...body }),
      // Survives the navigation the click is about to cause.
      keepalive: true,
    })
    if (response.ok) window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT))
    return response.ok
  } catch {
    return false
  }
}

export function NotificationInbox({
  orgSlug,
  workspaceSlug,
  groups,
  unreadOnly,
  nextHref,
  totalUnread,
}: {
  orgSlug: string
  workspaceSlug: string
  groups: InboxGroup[]
  unreadOnly: boolean
  /** Link to the next (older) page, or null on the last. */
  nextHref: string | null
  totalUnread: number
}) {
  const router = useRouter()
  const labels = useLabels()
  // Opportunity and Solution names are workspace-configurable (thinking model); the rest are fixed.
  const subjectLabel = (group: InboxGroup) =>
    group.subjectType === "OPPORTUNITY" ? labels.opportunity.singular : group.subjectType === "SOLUTION" ? labels.solution.singular : group.subjectLabel
  const [readIds, setReadIds] = useState<Set<string>>(new Set())
  const [notice, setNotice] = useState("")
  const [pending, startTransition] = useTransition()
  const base = `/${orgSlug}/${workspaceSlug}/notifications`

  const isRead = (item: { id: string; read: boolean }) => item.read || readIds.has(item.id)
  const unreadIn = (group: InboxGroup) => group.items.filter((item) => !isRead(item)).length
  const pageUnread = groups.reduce((sum, group) => sum + unreadIn(group), 0)

  function markGroupRead(group: InboxGroup) {
    const ids = group.items.filter((item) => !isRead(item)).map((item) => item.id)
    if (ids.length === 0) return
    setReadIds((current) => new Set([...current, ...ids]))
    void postRead(orgSlug, workspaceSlug, { ids })
  }

  function markAllRead() {
    setNotice("")
    startTransition(async () => {
      const ok = await postRead(orgSlug, workspaceSlug, { all: true })
      if (!ok) {
        setNotice("Could not mark notifications read. Please try again.")
        return
      }
      setReadIds(new Set(groups.flatMap((group) => group.items.map((item) => item.id))))
      router.refresh()
    })
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-8 md:px-10 md:py-12">
      <header className="mb-6">
        <p className="mb-2 text-xs font-medium tracking-widest text-text-subtle">THINGS YOU FOLLOW</p>
        <h1 className="text-3xl font-semibold tracking-tight text-text-primary">Notifications</h1>
        <p className="mt-2 text-text-secondary">
          Status changes and comments on the {labels.opportunity.lowerPlural}, {labels.solution.lowerPlural}, tasks and docs you follow.
        </p>
      </header>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <nav className="flex gap-1 rounded-lg bg-surface-inset p-1" aria-label="Notification filter">
          <Link href={base} aria-current={unreadOnly ? undefined : "page"} className={`rounded-md px-3 py-1 text-sm font-medium ${unreadOnly ? "text-text-secondary hover:text-text-primary" : "bg-secondary text-secondary-foreground"}`}>
            All
          </Link>
          <Link href={`${base}?filter=unread`} aria-current={unreadOnly ? "page" : undefined} className={`rounded-md px-3 py-1 text-sm font-medium ${unreadOnly ? "bg-secondary text-secondary-foreground" : "text-text-secondary hover:text-text-primary"}`}>
            Unread{totalUnread > 0 ? ` (${totalUnread > 99 ? "99+" : totalUnread})` : ""}
          </Link>
        </nav>
        <Button variant="outline" size="sm" disabled={pending || (pageUnread === 0 && totalUnread === 0)} onClick={markAllRead}>
          <CheckCheck aria-hidden="true" /> Mark all read
        </Button>
      </div>

      {notice && <p role="alert" className="mb-4 text-sm text-destructive">{notice}</p>}

      {groups.length === 0 ? (
        <section className="py-12 text-center">
          <BellOff className="mx-auto mb-4 size-8 text-text-subtle" aria-hidden="true" />
          <h2 className="text-xl font-medium">{unreadOnly ? "You’re all caught up." : "No notifications yet."}</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-text-secondary">
            Follow {labels.opportunity.indefinite}, {labels.solution.indefinite}, a task or a doc and its status changes and comments will show up here. You follow what you create, comment on or are assigned automatically.
          </p>
        </section>
      ) : (
        <section aria-label="Notifications by item" className="space-y-4">
          {groups.map((group) => {
            const unread = unreadIn(group)
            return (
              <article key={group.key} className="overflow-hidden rounded-xl border border-border bg-surface-card" data-slot="notification-group" data-unread={unread > 0}>
                <div className="flex items-start justify-between gap-3 border-b border-border p-4 md:px-5">
                  <div className="min-w-0">
                    <p className="mb-1 flex items-center gap-2 text-xs text-text-subtle">
                      <Badge variant="secondary">{subjectLabel(group)}</Badge>
                      <time dateTime={group.latestAt}>{formatWhen(group.latestAt)}</time>
                    </p>
                    {group.href && group.title ? (
                      <h2 className="break-words text-base font-semibold text-text-primary">
                        <Link href={group.href} onClick={() => markGroupRead(group)} className="hover:underline">{group.title}</Link>
                      </h2>
                    ) : (
                      <h2 className="text-base font-medium italic text-text-subtle">No longer available</h2>
                    )}
                  </div>
                  {unread > 0 && (
                    <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-semibold text-primary tabular-nums" aria-label={`${unread} unread`}>
                      {unread} new
                    </span>
                  )}
                </div>
                <ul className="divide-y divide-border">
                  {group.items.map((item) => (
                    <li key={item.id} className="flex items-start gap-3 px-4 py-3 text-sm md:px-5" data-read={isRead(item)}>
                      <span aria-hidden="true" className={`mt-1.5 size-2 shrink-0 rounded-full ${isRead(item) ? "bg-transparent" : "bg-primary"}`} />
                      <div className="min-w-0 flex-1">
                        <p className={isRead(item) ? "text-text-secondary" : "font-medium text-text-primary"}>{item.sentence}</p>
                        <p className="mt-0.5 text-xs text-text-subtle"><time dateTime={item.createdAt}>{formatWhen(item.createdAt)}</time></p>
                      </div>
                    </li>
                  ))}
                </ul>
              </article>
            )
          })}
        </section>
      )}

      {nextHref && (
        <div className="mt-6 flex justify-center">
          <Link href={nextHref} className={buttonVariants({ variant: "outline" })}>Older notifications</Link>
        </div>
      )}
    </main>
  )
}
