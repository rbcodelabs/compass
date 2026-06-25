"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Settings, BookOpen, HelpCircle } from "lucide-react"
import { cn } from "@/lib/utils"

interface MobileHeaderProps {
  orgSlug: string
  workspaceSlug: string
  workspaceName: string
}

export function MobileHeader({ orgSlug, workspaceSlug, workspaceName }: MobileHeaderProps) {
  const pathname = usePathname()
  const base = `/${orgSlug}/${workspaceSlug}`

  return (
    <header
      className="flex md:hidden items-center justify-between h-14 px-4 bg-slate-950 border-b border-slate-800/50 shrink-0 sticky top-0 z-30"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      {/* Logo + workspace name */}
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="w-7 h-7 rounded-lg bg-indigo-500 flex items-center justify-center shrink-0 shadow-sm">
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
        <span className="text-sm font-semibold text-white truncate max-w-[140px]">
          {workspaceName}
        </span>
      </div>

      {/* Right actions */}
      <div className="flex items-center gap-1 shrink-0">
        <Link
          href={`${base}/docs`}
          className={cn(
            "flex items-center justify-center w-9 h-9 rounded-lg transition-colors",
            pathname.startsWith(`${base}/docs`)
              ? "bg-indigo-600/20 text-indigo-400"
              : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
          )}
          aria-label="Docs"
        >
          <BookOpen className="w-4 h-4" aria-hidden="true" />
        </Link>
        <Link
          href={`${base}/settings`}
          className={cn(
            "flex items-center justify-center w-9 h-9 rounded-lg transition-colors",
            pathname.startsWith(`${base}/settings`)
              ? "bg-indigo-600/20 text-indigo-400"
              : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
          )}
          aria-label="Settings"
        >
          <Settings className="w-4 h-4" aria-hidden="true" />
        </Link>
        <Link
          href="/help"
          className={cn(
            "flex items-center justify-center w-9 h-9 rounded-lg transition-colors",
            pathname.startsWith("/help")
              ? "bg-indigo-600/20 text-indigo-400"
              : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
          )}
          aria-label="Help"
        >
          <HelpCircle className="w-4 h-4" aria-hidden="true" />
        </Link>
      </div>
    </header>
  )
}
