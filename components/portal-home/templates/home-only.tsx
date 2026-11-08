"use client"

import type { ReactNode } from "react"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"

function useIsHome(base: string): boolean {
  const pathname = usePathname()
  return pathname === base || pathname === `${base}/`
}

/** Renders its children on the portal home only (the template hero), never on roadmap/feedback. */
export function HomeOnly({ base, children }: { base: string; children: ReactNode }) {
  return useIsHome(base) ? <>{children}</> : null
}

/** `<main>` that takes an extra class on the home page only (e.g. the bento board overlapping its hero). */
export function PortalMain({ base, className, homeClassName, children }: { base: string; className?: string; homeClassName?: string; children: ReactNode }) {
  const isHome = useIsHome(base)
  return <main className={cn(className, isHome && homeClassName)}>{children}</main>
}
