"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Settings, BookOpen, HelpCircle, Lightbulb } from "lucide-react"
import { cn } from "@/lib/utils"
import { usePanelContext } from "@/components/panels/panel-context"

interface MobileHeaderProps {
  orgSlug: string
  workspaceSlug: string
  workspaceName: string
}

export function MobileHeader({ orgSlug, workspaceSlug, workspaceName }: MobileHeaderProps) {
  const pathname = usePathname()
  const { openPanel } = usePanelContext()
  const base = `/${orgSlug}/${workspaceSlug}`

  const discoveryBase = `${base}/discovery`
  const discoveryDetailMatch = pathname.startsWith(discoveryBase)
    ? /^\/([^/]+)\/?$/.exec(pathname.slice(discoveryBase.length))
    : null

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
      <div className="flex items-center gap-0.5 shrink-0">
        {discoveryDetailMatch && (
          <button
            onClick={() => openPanel("discovery-rail", discoveryDetailMatch[1])}
            className="flex flex-col items-center justify-center w-14 h-10 rounded-lg gap-0.5 text-slate-400 hover:bg-slate-800/60 hover:text-slate-200 transition-colors"
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
              ? "bg-indigo-600/20 text-indigo-400"
              : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
          )}
          aria-label="Docs"
        >
          <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
          <span className="text-[10px] font-medium leading-none">Docs</span>
        </Link>
        <Link
          href={`${base}/settings`}
          className={cn(
            "flex flex-col items-center justify-center w-14 h-10 rounded-lg gap-0.5 transition-colors",
            pathname.startsWith(`${base}/settings`)
              ? "bg-indigo-600/20 text-indigo-400"
              : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
          )}
          aria-label="Settings"
        >
          <Settings className="w-3.5 h-3.5" aria-hidden="true" />
          <span className="text-[10px] font-medium leading-none">Settings</span>
        </Link>
        <Link
          href="/help"
          className={cn(
            "flex flex-col items-center justify-center w-14 h-10 rounded-lg gap-0.5 transition-colors",
            pathname.startsWith("/help")
              ? "bg-indigo-600/20 text-indigo-400"
              : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
          )}
          aria-label="Help"
        >
          <HelpCircle className="w-3.5 h-3.5" aria-hidden="true" />
          <span className="text-[10px] font-medium leading-none">Help</span>
        </Link>
      </div>
    </header>
  )
}
