"use client"

import { useEffect, useState, type ReactNode } from "react"
import { usePathname } from "next/navigation"
import { Menu, X } from "lucide-react"
import { PortalNav } from "../portal-nav"
import { BrandMark } from "./brand"
import { cn } from "@/lib/utils"

interface Props {
  orgSlug: string
  workspaceSlug: string
  workspaceName: string
  logoUrl: string | null
  roadmapPublic: boolean
  feedbackEnabled: boolean
  showDocs: boolean
  authSlot: ReactNode
  children: ReactNode
}

function sectionLabel(pathname: string, base: string): string {
  if (pathname.startsWith(`${base}/roadmap`)) return "Roadmap"
  if (pathname.startsWith(`${base}/feedback`)) return "Feedback"
  return "Home"
}

/** Shell template chrome: a left sidebar on desktop, an off-canvas drawer below md. */
export function SidebarShell({ orgSlug, workspaceSlug, workspaceName, logoUrl, roadmapPublic, feedbackEnabled, showDocs, authSlot, children }: Props) {
  const base = `/portal/${orgSlug}/${workspaceSlug}`
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])

  return (
    <div className="flex min-h-screen bg-surface-app" data-testid="portal-shell-sidebar">
      {open ? <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setOpen(false)} aria-hidden /> : null}
      <aside
        id="portal-sidebar"
        aria-label="Portal sidebar"
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-64 flex-col gap-4 overflow-y-auto border-r border-border-default bg-surface-inset p-3 transition-transform md:sticky md:top-0 md:h-screen md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full invisible md:visible",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5 p-1.5">
            <BrandMark name={workspaceName} logoUrl={logoUrl} />
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-sm font-semibold text-text-primary">{workspaceName}</span>
              <span className="text-xs text-text-secondary">Customer portal</span>
            </span>
          </div>
          <button type="button" aria-label="Close menu" onClick={() => setOpen(false)} className="rounded-md p-2 text-text-secondary hover:bg-surface-interactive md:hidden">
            <X className="size-4" />
          </button>
        </div>
        <PortalNav orgSlug={orgSlug} workspaceSlug={workspaceSlug} roadmapPublic={roadmapPublic} feedbackEnabled={feedbackEnabled} showDocs={showDocs} variant="sidebar" onNavigate={() => setOpen(false)} />
        <p className="mt-auto border-t border-border-default px-2 pt-3 text-xs text-text-subtle">Powered by Compass</p>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border-default bg-surface-app px-4 sm:px-6">
          <button
            type="button"
            aria-label="Open menu"
            aria-expanded={open}
            aria-controls="portal-sidebar"
            onClick={() => setOpen(true)}
            className="-ml-1 rounded-md p-2 text-text-secondary hover:bg-surface-interactive md:hidden"
          >
            <Menu className="size-5" />
          </button>
          <div className="min-w-0 flex-1 truncate text-sm text-text-secondary">
            <span>{workspaceName}</span> <span className="text-border-strong">/</span>{" "}
            <h1 className="inline text-sm font-semibold text-text-primary">{sectionLabel(pathname, base)}</h1>
          </div>
          {authSlot}
        </div>
        {children}
      </div>
    </div>
  )
}
