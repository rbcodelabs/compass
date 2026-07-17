"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { Target, Lightbulb, FlaskConical, Map, MessageSquare, BookOpen, Settings, ChevronDown, HelpCircle, Check } from "lucide-react"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

interface SidebarProps {
  orgSlug: string
  workspaceSlug: string
  workspaceName: string
  userName: string
  userImage?: string
  workspaces: { id: string; name: string; slug: string; orgSlug: string }[]
}

const navItems = [
  { label: "OKRs", path: "okrs", Icon: Target },
  { label: "Discovery", path: "discovery", Icon: Lightbulb },
  { label: "Experiments", path: "experiments", Icon: FlaskConical },
  { label: "Roadmap", path: "roadmap", Icon: Map },
  { label: "Feedback", path: "feedback", Icon: MessageSquare },
  { label: "Docs", path: "docs", Icon: BookOpen },
]

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase()
}

export function Sidebar({
  orgSlug,
  workspaceSlug,
  workspaceName,
  userName,
  userImage,
  workspaces,
}: SidebarProps) {
  const pathname = usePathname()
  const router = useRouter()
  const base = `/${orgSlug}/${workspaceSlug}`

  // Strip the /{orgSlug}/{workspaceSlug} prefix to get the current section (e.g. "/okrs")
  const currentSection = pathname.startsWith(base) ? pathname.slice(base.length) : ""

  const otherWorkspaces = workspaces.filter(
    (ws) => !(ws.slug === workspaceSlug && ws.orgSlug === orgSlug)
  )

  return (
    <aside className="hidden md:flex w-[220px] shrink-0 flex-col h-full bg-slate-950 text-slate-100 border-r border-slate-800/50">
      {/* Logo + app name */}
      <div className="flex items-center gap-2.5 px-4 pt-5 pb-4">
        <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center shrink-0 shadow-sm">
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
        <span className="font-semibold text-sm tracking-tight text-white">Compass</span>
      </div>

      {/* Workspace selector */}
      <div className="px-3 pb-4">
        <DropdownMenu>
          <DropdownMenuTrigger className="w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-slate-800/60 transition-colors group">
            <div className="w-5 h-5 rounded-md bg-primary/30 border border-primary/30 flex items-center justify-center shrink-0">
              <span className="text-[10px] font-bold text-primary leading-none">
                {workspaceName[0]?.toUpperCase() ?? "W"}
              </span>
            </div>
            <span className="text-xs font-medium text-slate-300 truncate flex-1">{workspaceName}</span>
            <ChevronDown className="w-3 h-3 text-slate-500 shrink-0 group-hover:text-slate-400 transition-colors" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="bg-slate-900 text-slate-200 ring-slate-700">
            {workspaces.map((ws) => (
              <DropdownMenuItem
                key={ws.id}
                className="flex items-center gap-2 hover:bg-slate-800 focus:bg-slate-800 focus:text-slate-100 cursor-pointer"
                onClick={() => router.push(`/${ws.orgSlug}/${ws.slug}${currentSection}`)}
              >
                <div className="w-4 h-4 flex items-center justify-center shrink-0">
                  {ws.slug === workspaceSlug && ws.orgSlug === orgSlug && (
                    <Check className="w-3.5 h-3.5 text-primary" aria-hidden="true" />
                  )}
                </div>
                <span className="truncate">{ws.name}</span>
              </DropdownMenuItem>
            ))}
            {otherWorkspaces.length === 0 && (
              <>
                <DropdownMenuSeparator className="bg-slate-700" />
                <DropdownMenuItem
                  disabled
                  className="text-slate-500 focus:bg-transparent focus:text-slate-500 cursor-default"
                >
                  No other workspaces
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="mx-3 h-px bg-slate-800/70" />

      {/* Nav links */}
      <nav className="flex-1 px-2 py-3 space-y-0.5" aria-label="Main navigation">
        {navItems.map(({ label, path, Icon }) => {
          const href = `${base}/${path}`
          const isActive = pathname.startsWith(href)

          return (
            <Link
              key={path}
              href={href}
              className={cn(
                "relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-all duration-150",
                isActive
                  ? "bg-primary/20 text-white"
                  : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-200"
              )}
            >
              {/* Active left accent bar */}
              {isActive && (
                <span
                  className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 bg-primary rounded-full"
                  aria-hidden="true"
                />
              )}
              <Icon
                className={cn(
                  "w-4 h-4 shrink-0 transition-colors",
                  isActive ? "text-primary" : "text-slate-500"
                )}
                aria-hidden="true"
              />
              {label}
            </Link>
          )
        })}
      </nav>

      <div className="mx-3 h-px bg-slate-800/70" />

      {/* Settings */}
      <nav className="px-2 py-2" aria-label="Settings navigation">
        {(() => {
          const href = `${base}/settings`
          const isActive = pathname.startsWith(href)
          return (
            <Link
              href={href}
              className={cn(
                "relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-all duration-150",
                isActive
                  ? "bg-primary/20 text-white"
                  : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-200"
              )}
            >
              {isActive && (
                <span
                  className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 bg-primary rounded-full"
                  aria-hidden="true"
                />
              )}
              <Settings
                className={cn(
                  "w-4 h-4 shrink-0 transition-colors",
                  isActive ? "text-primary" : "text-slate-500"
                )}
                aria-hidden="true"
              />
              Settings
            </Link>
          )
        })()}
      </nav>

      <div className="mx-3 h-px bg-slate-800/70" />

      {/* Help — absolute link, outside workspace scope */}
      <nav className="px-2 py-2" aria-label="Help navigation">
        <Link
          href="/help"
          className={cn(
            "relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-all duration-150",
            pathname.startsWith("/help")
              ? "bg-primary/20 text-white"
              : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-200"
          )}
        >
          {pathname.startsWith("/help") && (
            <span
              className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 bg-primary rounded-full"
              aria-hidden="true"
            />
          )}
          <HelpCircle
            className={cn(
              "w-4 h-4 shrink-0 transition-colors",
              pathname.startsWith("/help") ? "text-primary" : "text-slate-500"
            )}
            aria-hidden="true"
          />
          Help
        </Link>
      </nav>

      <div className="mx-3 h-px bg-slate-800/70" />

      {/* User */}
      <div className="flex items-center gap-2.5 px-3.5 py-3.5">
        <Avatar className="w-6 h-6 shrink-0">
          {userImage && <AvatarImage src={userImage} alt={userName} />}
          <AvatarFallback className="text-[10px] font-semibold bg-slate-700 text-slate-200">
            {getInitials(userName || "?")}
          </AvatarFallback>
        </Avatar>
        <span className="text-xs text-slate-400 truncate">{userName}</span>
      </div>
    </aside>
  )
}
