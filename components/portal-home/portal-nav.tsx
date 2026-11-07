"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { FileText, Home, MessageSquare, Route } from "lucide-react"
import { cn } from "@/lib/utils"

export type PortalNavVariant = "default" | "onBrand" | "onDark" | "sidebar"

interface Props {
  orgSlug: string
  workspaceSlug: string
  roadmapPublic: boolean
  feedbackEnabled: boolean
  /** Adds a Docs link to the home page's docs section (only when the home has a docs widget). */
  showDocs?: boolean
  variant?: PortalNavVariant
  /** Called after a link is chosen (closes the mobile drawer). */
  onNavigate?: () => void
}

const LINK_CLASS: Record<PortalNavVariant, { base: string; active: string; idle: string }> = {
  default: { base: "rounded-md px-3 py-1.5 text-sm font-medium", active: "bg-surface-interactive text-text-primary", idle: "text-text-subtle hover:text-text-primary" },
  onBrand: { base: "rounded-full px-3.5 py-2 text-sm font-semibold", active: "bg-white/25 text-primary-foreground", idle: "text-primary-foreground/90 hover:bg-white/15" },
  onDark: { base: "px-3 py-2 text-sm font-medium", active: "text-[#FAF9F6] shadow-[inset_0_-2px_0_#A294FF]", idle: "text-[#B9B3A9] hover:text-[#FAF9F6]" },
  sidebar: { base: "flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm font-medium", active: "bg-surface-interactive text-text-primary [&_svg]:text-primary", idle: "text-text-secondary hover:bg-surface-interactive hover:text-text-primary" },
}

const ICONS = { home: Home, docs: FileText, roadmap: Route, feedback: MessageSquare } as const

/** Portal navigation. Home is always present; the other surfaces only when enabled. */
export function PortalNav({ orgSlug, workspaceSlug, roadmapPublic, feedbackEnabled, showDocs = false, variant = "default", onNavigate }: Props) {
  const pathname = usePathname()
  const base = `/portal/${orgSlug}/${workspaceSlug}`
  const links = [
    { key: "home", href: base, label: "Home", show: true },
    { key: "docs", href: `${base}#docs`, label: "Docs", show: showDocs },
    { key: "roadmap", href: `${base}/roadmap`, label: "Roadmap", show: roadmapPublic },
    { key: "feedback", href: `${base}/feedback`, label: "Feedback", show: feedbackEnabled },
  ] as const
  const style = LINK_CLASS[variant]
  return (
    <nav aria-label="Portal" className={cn("flex items-center gap-1", variant === "sidebar" && "flex-col items-stretch gap-0.5")}>
      {links.filter((link) => link.show).map((link) => {
        // The Docs entry is an in-page anchor on Home, so it is never the "current page".
        const active = link.key === "docs" ? false : link.href === base ? pathname === base : pathname.startsWith(link.href)
        const Icon = ICONS[link.key]
        return (
          <Link
            key={link.key}
            href={link.href}
            aria-current={active ? "page" : undefined}
            onClick={onNavigate}
            className={cn(style.base, active ? style.active : style.idle)}
          >
            {variant === "sidebar" ? <Icon className="size-4 shrink-0" aria-hidden /> : null}
            {link.label}
          </Link>
        )
      })}
    </nav>
  )
}
