"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Target, Lightbulb, Puzzle, FlaskConical, Map, MessageSquare, ListChecks, MessageSquareCheck, Clock3, BarChart3, House } from "lucide-react"
import { cn } from "@/lib/utils"
import { useLabels } from "@/components/thinking-model/thinking-model-provider"
import { orderPrimaryNav } from "@/lib/workspace-nav"

interface BottomNavProps {
  orgSlug: string
  workspaceSlug: string
  researchCaptureEnabled?: boolean
  updatesEnabled?: boolean
}

// A function, not a constant: the OKRs entry's name comes from the workspace's thinking model.
const buildBaseNavItems = (okrsLabel: string, discoveryLabel: string, solutionsLabel: string, discoveryFirst: boolean) => orderPrimaryNav([
  { label: okrsLabel, path: "okrs", Icon: Target },
  { label: discoveryLabel, path: "discovery", Icon: Lightbulb },
  { label: solutionsLabel, path: "solutions", Icon: Puzzle },
  { label: "Experiments", path: "experiments", Icon: FlaskConical },
  { label: "Roadmap", path: "roadmap", Icon: Map },
  { label: "Metrics", path: "metrics", Icon: BarChart3 },
  { label: "Tasks", path: "tasks", Icon: ListChecks },
  { label: "Decisions", path: "decisions", Icon: MessageSquareCheck },
], discoveryFirst)

export function BottomNav({ orgSlug, workspaceSlug, researchCaptureEnabled = true, updatesEnabled = false }: BottomNavProps) {
  const pathname = usePathname()
  const base = `/${orgSlug}/${workspaceSlug}`
  const labels = useLabels()
  const baseNavItems = buildBaseNavItems(labels.sections.okrs, labels.opportunity.plural, labels.solution.plural, labels.sections.discoveryFirst)
  const navItems = [
    { label: "Home", path: "home", Icon: House },
    ...(updatesEnabled ? [{ label: "Updates", path: "updates", Icon: Clock3 }] : []),
    ...baseNavItems,
    researchCaptureEnabled
      ? { label: "Capture", path: "capture", Icon: MessageSquare }
      : { label: "Feedback", path: "feedback", Icon: MessageSquare },
  ]

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 flex overflow-x-auto md:hidden bg-sidebar border-t border-sidebar-border"
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
              "relative flex flex-1 flex-col items-center justify-center gap-1 py-2.5 min-w-[64px] min-h-[56px] transition-colors duration-150",
              isActive
                ? "text-primary"
                : "text-text-subtle hover:text-text-primary active:text-text-primary"
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
                isActive ? "text-primary" : "text-text-subtle"
              )}
              aria-hidden="true"
            />
            <span
              className={cn(
                "text-[10px] font-medium leading-none",
                isActive ? "text-primary" : "text-text-subtle"
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
