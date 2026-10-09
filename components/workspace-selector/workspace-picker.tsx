"use client"

import { useMemo, useRef, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { ChevronDown, LayoutGrid, Plus, Search, X } from "lucide-react"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { SidebarMenuButton } from "@/components/ui/sidebar"
import { getWorkspaceSwitchPath } from "@/lib/workspace-nav"

import { groupByOrg, matchesQuery, recentWorkspaces, workspaceKey, type SelectorWorkspace } from "./model"
import { useWorkspaceVisits } from "./visits"
import { WorkspaceAvatar } from "./workspace-cover"
import { WorkspaceRow } from "./workspace-row"
import "./workspace-selector.css"

interface WorkspacePickerProps {
  workspaces: SelectorWorkspace[]
  orgSlug: string
  workspaceSlug: string
  workspaceName: string
  /** Scopes the "Recent" history to one account (browsers are shared). */
  userScope?: string
}

/**
 * Sidebar workspace switcher: a searchable popout with recents, org grouping and
 * links to the full gallery. Rows keep the current top-level section when
 * switching (see getWorkspaceSwitchPath).
 */
export function WorkspacePicker({ workspaces, orgSlug, workspaceSlug, workspaceName, userScope }: WorkspacePickerProps) {
  const pathname = usePathname()
  const visits = useWorkspaceVisits(userScope)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const popRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const trimmed = query.trim()
  const isCurrent = (w: SelectorWorkspace) => w.slug === workspaceSlug && w.orgSlug === orgSlug
  const hasOthers = workspaces.some((w) => !isCurrent(w))
  const multiOrg = useMemo(() => new Set(workspaces.map((w) => w.orgSlug)).size > 1, [workspaces])

  const filtered = useMemo(() => workspaces.filter((w) => matchesQuery(w, trimmed)), [workspaces, trimmed])
  const groups = useMemo(() => groupByOrg(filtered), [filtered])
  const recents = useMemo(() => recentWorkspaces(workspaces, visits, 3), [workspaces, visits])
  const showRecents = !trimmed && workspaces.length > 4 && recents.length > 0

  const hrefFor = (w: SelectorWorkspace) =>
    getWorkspaceSwitchPath(pathname, orgSlug, workspaceSlug, w.orgSlug, w.slug)

  const close = () => setOpen(false)
  const items = (): HTMLElement[] =>
    Array.from(popRef.current?.querySelectorAll<HTMLElement>("[data-wsx-item]") ?? [])

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) setQuery("")
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return
    const target = e.target as HTMLElement
    const all = items()

    if (target === inputRef.current) {
      if (e.key === "ArrowDown" && all.length) {
        e.preventDefault()
        all[0].focus()
      } else if (e.key === "Enter" && trimmed && all.length) {
        e.preventDefault()
        all[0].click()
      } else if (e.key === "Escape" && query) {
        // First Esc clears the filter; a second one closes the popout.
        e.preventDefault()
        e.stopPropagation()
        setQuery("")
      }
      return
    }

    if (!target.hasAttribute("data-wsx-item")) return
    const i = all.indexOf(target)
    if (e.key === "ArrowDown") {
      e.preventDefault()
      all[Math.min(i + 1, all.length - 1)]?.focus()
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      if (i <= 0) inputRef.current?.focus()
      else all[i - 1].focus()
    }
  }

  const createHref = `/${orgSlug}/settings`

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <SidebarMenuButton
            size="lg"
            tooltip={`Workspace: ${workspaceName}`}
            className="text-text-secondary hover:bg-sidebar-accent hover:text-sidebar-foreground data-popup-open:bg-sidebar-accent"
            aria-label={`Switch workspace. Current workspace: ${workspaceName}`}
          />
        }
      >
        <WorkspaceAvatar name={workspaceName} size="sm" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{workspaceName}</span>
        <ChevronDown className="ml-auto size-3 text-text-subtle group-data-[collapsible=icon]:hidden" />
      </PopoverTrigger>

      <PopoverContent side="right" align="start" sideOffset={8} className="wsx wsx-pop" initialFocus={inputRef} aria-label="Switch workspace">
        <div ref={popRef} onKeyDown={onKeyDown} className="contents">
          <div className="wsx-pop-search" data-filled={query.length > 0}>
            <Search className="wsx-icon" aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a workspace…"
              aria-label="Find a workspace"
              autoComplete="off"
              spellCheck={false}
            />
            {query.length > 0 && (
              <button
                type="button"
                className="wsx-pop-clear"
                aria-label="Clear search"
                onClick={() => {
                  setQuery("")
                  inputRef.current?.focus()
                }}
              >
                <X className="wsx-icon" aria-hidden="true" />
              </button>
            )}
          </div>

          <div className="wsx-pop-list">
            {showRecents && (
              <div role="group" aria-label="Recent">
                <div className="wsx-pop-label">Recent</div>
                {recents.map((w) => (
                  <WorkspaceRow
                    key={`recent-${workspaceKey(w)}`}
                    workspace={w}
                    href={hrefFor(w)}
                    isCurrent={isCurrent(w)}
                    onNavigate={close}
                  />
                ))}
              </div>
            )}

            {filtered.length > 0 && (
              <div className="wsx-pop-label">{trimmed ? "Results" : "All"}</div>
            )}
            {groups.map((g) => (
              <div key={g.orgSlug} role="group" aria-label={multiOrg ? g.orgName : undefined}>
                {multiOrg && (
                  <div className="wsx-pop-label" data-org="true">
                    <span>{g.orgName}</span>
                    <span className="n">{g.items.length}</span>
                  </div>
                )}
                {g.items.map((w) => (
                  <WorkspaceRow
                    key={workspaceKey(w)}
                    workspace={w}
                    href={hrefFor(w)}
                    isCurrent={isCurrent(w)}
                    onNavigate={close}
                  />
                ))}
              </div>
            ))}

            {filtered.length === 0 && (
              <div className="wsx-pop-empty" role="status">
                <strong>No workspaces match</strong>
                Try another name.
              </div>
            )}
            {!hasOthers && !trimmed && <div className="wsx-pop-empty">No other workspaces</div>}
          </div>

          <div className="wsx-pop-foot">
            {workspaces.length > 1 && (
              <Link href="/dashboard" className="wsx-act" data-wsx-item="" onClick={close}>
                <LayoutGrid className="wsx-icon" aria-hidden="true" />
                All workspaces
              </Link>
            )}
            <Link href={createHref} className="wsx-act" data-wsx-item="" onClick={close}>
              <Plus className="wsx-icon" aria-hidden="true" />
              Create workspace
            </Link>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
