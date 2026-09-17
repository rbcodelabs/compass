"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Settings, BookOpen, HelpCircle, Lightbulb, CircleUser, Building2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { usePanelContext } from "@/components/panels/panel-context"
import { signOutAction } from "@/lib/actions/auth-actions"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { SendCompassFeedbackDialog } from "@/components/feedback/send-compass-feedback-dialog"

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase()
}

interface MobileHeaderProps {
  orgSlug: string
  workspaceSlug: string
  workspaceName: string
  userName: string
  userEmail: string
  userImage?: string
  /** Org admins/owners see an "Org Settings" link in the account menu. */
  isOrgAdmin?: boolean
}

export function MobileHeader({
  orgSlug,
  workspaceSlug,
  workspaceName,
  userName,
  userEmail,
  userImage,
  isOrgAdmin = false,
}: MobileHeaderProps) {
  const pathname = usePathname()
  const { openPanel } = usePanelContext()
  const base = `/${orgSlug}/${workspaceSlug}`

  const discoveryBase = `${base}/discovery`
  const discoveryDetailMatch = pathname.startsWith(discoveryBase)
    ? /^\/([^/]+)\/?$/.exec(pathname.slice(discoveryBase.length))
    : null

  return (
    <header
      className="flex md:hidden items-center justify-between h-14 px-4 bg-sidebar border-b border-sidebar-border shrink-0 sticky top-0 z-30"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      {/* Logo + workspace name */}
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center shrink-0">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-4 h-4"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
          </svg>
        </div>
        <span className="text-sm font-semibold text-sidebar-foreground truncate max-w-[140px]">
          {workspaceName}
        </span>
      </div>

      {/* Right actions */}
      <div className="flex items-center gap-0.5 shrink-0">
        {discoveryDetailMatch && (
          <button
            onClick={() => openPanel("discovery-rail", discoveryDetailMatch[1])}
            className="flex flex-col items-center justify-center w-14 h-10 rounded-lg gap-0.5 text-text-subtle hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
            aria-label="Browse opportunities"
          >
            <Lightbulb className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="text-[10px] font-medium leading-none">Browse</span>
          </button>
        )}
        <Link
          href={`${base}/docs`}
          className={cn(
            "flex flex-col items-center justify-center w-14 h-10 rounded-lg gap-0.5 transition-colors",
            pathname.startsWith(`${base}/docs`)
              ? "bg-primary/10 text-primary"
              : "text-text-subtle hover:bg-sidebar-accent hover:text-sidebar-foreground"
          )}
          aria-label="Docs"
        >
          <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
          <span className="text-[10px] font-medium leading-none">Docs</span>
        </Link>
        <DropdownMenu>
          <DropdownMenuTrigger
            className="flex flex-col items-center justify-center w-14 h-10 rounded-lg gap-0.5 text-text-subtle hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
            aria-label="Account"
          >
            <CircleUser className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="text-[10px] font-medium leading-none">Account</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-[220px]">
            <div className="flex items-center gap-2.5 px-1.5 py-1.5">
              <Avatar className="w-7 h-7 shrink-0">
                {userImage && <AvatarImage src={userImage} alt={userName} />}
                <AvatarFallback className="text-[10px] font-semibold bg-surface-inset text-text-primary">
                  {getInitials(userName || "?")}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="text-sm font-medium text-text-primary truncate">{userName}</p>
                <p className="text-xs text-text-subtle truncate">{userEmail}</p>
              </div>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="p-0 cursor-pointer">
              <Link
                href={`${base}/settings`}
                className="flex w-full items-center gap-2 px-1.5 py-1"
              >
                <Settings className="w-3.5 h-3.5 shrink-0 text-text-subtle" aria-hidden="true" />
                Settings
              </Link>
            </DropdownMenuItem>
            {isOrgAdmin && (
              <DropdownMenuItem className="p-0 cursor-pointer">
                <Link
                  href={`/${orgSlug}/settings`}
                  className="flex w-full items-center gap-2 px-1.5 py-1"
                >
                  <Building2 className="w-3.5 h-3.5 shrink-0 text-text-subtle" aria-hidden="true" />
                  Org Settings
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem className="p-0 cursor-pointer">
              <Link
                href="/help"
                className="flex w-full items-center gap-2 px-1.5 py-1"
              >
                <HelpCircle className="w-3.5 h-3.5 shrink-0 text-text-subtle" aria-hidden="true" />
                Help
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem className="p-0 cursor-pointer" closeOnClick={false}>
              <SendCompassFeedbackDialog />
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="p-0 cursor-pointer">
              <Link href="/settings/agents" className="flex w-full items-center px-1.5 py-1">My agents</Link>
            </DropdownMenuItem>
            <DropdownMenuItem className="cursor-pointer p-0">
              <form action={signOutAction} className="w-full">
                <button
                  type="submit"
                  className="w-full text-left px-1.5 py-1 cursor-pointer"
                >
                  Sign out
                </button>
              </form>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
