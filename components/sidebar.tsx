"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Target, Lightbulb, FlaskConical, Map, Settings } from "lucide-react"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { cn } from "@/lib/utils"

interface SidebarProps {
  orgSlug: string
  workspaceSlug: string
  workspaceName: string
  userName: string
  userImage?: string
}

const navItems = [
  { label: "OKRs", path: "okrs", Icon: Target },
  { label: "Discovery", path: "discovery", Icon: Lightbulb },
  { label: "Experiments", path: "experiments", Icon: FlaskConical },
  { label: "Roadmap", path: "roadmap", Icon: Map },
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
}: SidebarProps) {
  const pathname = usePathname()
  const base = `/${orgSlug}/${workspaceSlug}`

  return (
    <aside className="w-60 shrink-0 flex flex-col h-full bg-slate-900 text-slate-100">
      {/* Logo */}
      <div className="flex items-center gap-2 px-4 py-5">
        <div className="w-7 h-7 rounded-md bg-white flex items-center justify-center shrink-0">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#0f172a"
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
        <span className="font-semibold text-sm tracking-tight">Compass</span>
      </div>

      {/* Workspace name */}
      <div className="px-4 pb-4">
        <p className="text-xs text-slate-400 uppercase tracking-wider font-medium mb-1">
          Workspace
        </p>
        <p className="text-sm font-medium text-slate-100 truncate">{workspaceName}</p>
      </div>

      <div className="mx-4 h-px bg-slate-700" />

      {/* Nav links */}
      <nav className="flex-1 px-2 py-4 space-y-1">
        {navItems.map(({ label, path, Icon }) => {
          const href = `${base}/${path}`
          const isActive = pathname.startsWith(href)

          return (
            <Link
              key={path}
              href={href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-slate-700 text-white"
                  : "text-slate-400 hover:bg-slate-800 hover:text-slate-100"
              )}
            >
              <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
              {label}
            </Link>
          )
        })}
      </nav>

      <div className="mx-4 h-px bg-slate-700" />

      {/* Settings */}
      <nav className="px-2 py-2">
        {(() => {
          const href = `${base}/settings`
          const isActive = pathname.startsWith(href)
          return (
            <Link
              href={href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-slate-700 text-white"
                  : "text-slate-400 hover:bg-slate-800 hover:text-slate-100"
              )}
            >
              <Settings className="w-4 h-4 shrink-0" aria-hidden="true" />
              Settings
            </Link>
          )
        })()}
      </nav>

      <div className="mx-4 h-px bg-slate-700" />

      {/* User */}
      <div className="flex items-center gap-3 px-4 py-4">
        <Avatar className="w-7 h-7 shrink-0">
          {userImage && <AvatarImage src={userImage} alt={userName} />}
          <AvatarFallback className="text-xs bg-slate-700 text-slate-100">
            {getInitials(userName || "?")}
          </AvatarFallback>
        </Avatar>
        <span className="text-sm text-slate-300 truncate">{userName}</span>
      </div>
    </aside>
  )
}
