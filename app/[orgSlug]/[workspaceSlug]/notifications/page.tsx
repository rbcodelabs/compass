import { redirect } from "next/navigation"
import getPrisma from "@/lib/db"
import { followingAvailable } from "@/lib/following-flag"
import { toInboxGroups } from "@/lib/notification-inbox"
import { listNotifications, unreadCount } from "@/lib/notifications"
import { getSessionUser } from "@/lib/session"
import { requireWorkspaceContext } from "@/lib/workspace-context"
import { NotificationInbox } from "@/components/notifications/notification-inbox"

export const metadata = { title: "Notifications" }

const PAGE_SIZE = 25

/**
 * The inbox. Server-rendered from listNotifications, which is the authority on
 * access: it needs a current workspace member and re-checks each subject, so a
 * title the viewer cannot open never reaches the client component.
 */
export default async function NotificationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<{ cursor?: string; filter?: string }>
}) {
  const [{ orgSlug, workspaceSlug }, query] = await Promise.all([params, searchParams])
  const user = await getSessionUser()
  if (!user) redirect("/login")
  const { workspace } = await requireWorkspaceContext(orgSlug, workspaceSlug)

  const prisma = getPrisma()
  if (!(await followingAvailable(prisma))) {
    return (
      <main className="mx-auto w-full max-w-3xl px-5 py-8 md:px-10 md:py-12">
        <h1 className="text-3xl font-semibold tracking-tight text-text-primary">Notifications</h1>
        <section className="mt-8 rounded-xl border border-border bg-surface-card p-8">
          <h2 className="font-semibold">Notifications are getting ready</h2>
          <p className="mt-2 text-sm text-text-secondary">Following will start collecting notifications for you when this feature is enabled.</p>
        </section>
      </main>
    )
  }

  const unreadOnly = query.filter === "unread"
  const [page, unread] = await Promise.all([
    listNotifications(user.id, workspace.id, { limit: PAGE_SIZE, cursor: query.cursor, unreadOnly }),
    unreadCount(user.id, workspace.id),
  ])
  const base = `/${orgSlug}/${workspaceSlug}`
  const params2 = new URLSearchParams()
  if (page.nextCursor) params2.set("cursor", page.nextCursor)
  if (unreadOnly) params2.set("filter", "unread")

  return (
    <NotificationInbox
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      groups={toInboxGroups(page, base)}
      unreadOnly={unreadOnly}
      nextHref={page.nextCursor ? `${base}/notifications?${params2.toString()}` : null}
      totalUnread={unread.count}
    />
  )
}
