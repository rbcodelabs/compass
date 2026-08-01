"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Target, Lightbulb, FlaskConical, Map, MessageSquare, ListChecks } from "lucide-react"
import { cn } from "@/lib/utils"

interface BottomNavProps {
  orgSlug: string
  workspaceSlug: string
}

const navItems = [
  { label: "OKRs", path: "okrs", Icon: Target },
  { label: "Discovery", path: "discovery", Icon: Lightbulb },
  { label: "Experiments", path: "experiments", Icon: FlaskConical },
  { label: "Roadmap", path: "roadmap", Icon: Map },
  { label: "Tasks", path: "tasks", Icon: ListChecks },
  { label: "Feedback", path: "feedback", Icon: MessageSquare },
]

export function BottomNav({ orgSlug, workspaceSlug }: BottomNavProps) {
  const pathname = usePathname()
  const base = `/${orgSlug}/${workspaceSlug}`

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 flex md:hidden bg-slate-950 border-t border-slate-800/50"
      aria-label="Primary navigation"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {navItems.map(({ label, path, Icon }) => {
        const href = `${base}/${path}`
        const isActive = pathname.startsWith(href)

        return (
          <Link
            key={path}
            href={href}
            className={cn(
              "relative flex flex-1 flex-col items-center justify-center gap-1 py-2.5 min-w-0 min-h-[56px] transition-colors duration-150",
              isActive ? "text-primary" : "text-slate-500 hover:text-slate-300 active:text-slate-200"
            )}
            aria-current={isActive ? "page" : undefined}
          >
            {isActive && (
              <span
                className="absolute top-0 left-1/2 -translate-x-1/2 h-0.5 w-8 bg-primary rounded-full"
                aria-hidden="true"
              />
            )}
            <Icon
              className={cn(
                "w-5 h-5 shrink-0",
                isActive ? "text-primary" : "text-slate-500"
              )}
              aria-hidden="true"
            />
            <span
              className={cn(
                "text-[10px] font-medium leading-none",
                isActive ? "text-primary" : "text-slate-500"
              )}
            >
              {label}
            </span>
          </Link>
        )
      })}
    </nav>
  )
}
