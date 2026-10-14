"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"

interface Props {
  orgSlug: string
  workspaceSlug: string
  roadmapPublic: boolean
  feedbackEnabled: boolean
}

/** Portal top navigation. Home is always present; the other surfaces only when enabled. */
export function PortalNav({ orgSlug, workspaceSlug, roadmapPublic, feedbackEnabled }: Props) {
  const pathname = usePathname()
  const base = `/portal/${orgSlug}/${workspaceSlug}`
  const links = [
    { href: base, label: "Home", show: true },
    { href: `${base}/roadmap`, label: "Roadmap", show: roadmapPublic },
    { href: `${base}/feedback`, label: "Feedback", show: feedbackEnabled },
  ].filter((link) => link.show)
  return (
    <nav aria-label="Portal" className="flex items-center gap-1">
      {links.map((link) => {
        const active = link.href === base ? pathname === base : pathname.startsWith(link.href)
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={cn("rounded-md px-3 py-1.5 text-sm font-medium", active ? "bg-surface-interactive text-text-primary" : "text-text-subtle hover:text-text-primary")}
          >
            {link.label}
          </Link>
        )
      })}
    </nav>
  )
}
