"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useCallback } from "react"
import { Bell } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatUnread } from "@/lib/notification-text"
import { NOTIFICATIONS_CHANGED_EVENT, useLiveUnread } from "@/lib/notifications-live-client"
import { SidebarMenuButton } from "@/components/ui/sidebar"

export { NOTIFICATIONS_CHANGED_EVENT }

type BellProps = {
  orgSlug: string
  workspaceSlug: string
  initialCount: number
  initialOverflow: boolean
}

const labelFor = (count: number, overflow: boolean) =>
  count === 0 ? "Notifications" : `Notifications, ${formatUnread(count, overflow)} unread`

/** Compact bell that sits beside Search: icon only, count badge on the corner. */
export function NotificationBellIconButton({ orgSlug, workspaceSlug, initialCount, initialOverflow }: BellProps) {
  const pathname = usePathname()
  const router = useRouter()
  const navigate = useCallback((href: string) => router.push(href), [router])
  const { count, overflow } = useLiveUnread(
    orgSlug,
    workspaceSlug,
    { count: initialCount, overflow: initialOverflow },
    pathname,
    navigate,
  )
  const href = `/${orgSlug}/${workspaceSlug}/notifications`
  const isActive = pathname.startsWith(href)

  return (
    <div className="relative shrink-0">
      <SidebarMenuButton
        render={<Link href={href} />}
        isActive={isActive}
        tooltip={count > 0 ? `Notifications (${formatUnread(count, overflow)})` : "Notifications"}
        aria-label={labelFor(count, overflow)}
        className="h-9 w-9 justify-center rounded-lg p-0 text-text-secondary group-data-[collapsible=icon]:size-8!"
        data-slot="notification-bell"
      >
        <Bell className={isActive ? "text-primary" : "text-text-subtle"} aria-hidden="true" />
      </SidebarMenuButton>
      {count > 0 && (
        <>
          {/* Wide counts ("99+") sit fully off the icon's corner; the 56px collapsed rail swaps in a dot so nothing clips or reaches the Search button above. */}
          <span
            aria-hidden="true"
            data-testid="notification-count"
            className="pointer-events-none absolute -right-1 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground tabular-nums ring-2 ring-sidebar group-data-[collapsible=icon]:hidden"
          >
            {formatUnread(count, overflow)}
          </span>
          <span
            aria-hidden="true"
            data-testid="notification-dot"
            className="pointer-events-none absolute right-1 top-1 hidden size-2 rounded-full bg-primary ring-2 ring-sidebar group-data-[collapsible=icon]:block"
          />
        </>
      )}
    </div>
  )
}

/** Mobile header button, styled like its Docs and Account neighbours. */
export function NotificationBellHeaderLink({ orgSlug, workspaceSlug, initialCount, initialOverflow }: BellProps) {
  const pathname = usePathname()
  const router = useRouter()
  const navigate = useCallback((href: string) => router.push(href), [router])
  const { count, overflow } = useLiveUnread(
    orgSlug,
    workspaceSlug,
    { count: initialCount, overflow: initialOverflow },
    pathname,
    navigate,
  )
  const href = `/${orgSlug}/${workspaceSlug}/notifications`

  return (
    <Link
      href={href}
      aria-label={labelFor(count, overflow)}
      className={cn(
        "relative flex h-10 w-14 flex-col items-center justify-center gap-0.5 rounded-lg transition-colors",
        pathname.startsWith(href) ? "bg-primary/10 text-primary" : "text-text-subtle hover:bg-sidebar-accent hover:text-sidebar-foreground"
      )}
      data-slot="notification-bell"
    >
      <Bell className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="text-[10px] font-medium leading-none">Inbox</span>
      {count > 0 && (
        <span
          aria-hidden="true"
          data-testid="notification-count"
          className="absolute right-2 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground tabular-nums"
        >
          {formatUnread(count, overflow)}
        </span>
      )}
    </Link>
  )
}
