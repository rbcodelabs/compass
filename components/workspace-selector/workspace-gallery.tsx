"use client"

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import Link from "next/link"
import { Plus, Search, X } from "lucide-react"

import { signOutAction } from "@/lib/actions/auth-actions"

import {
  greetingFor,
  groupByOrg,
  matchesQuery,
  pluralize,
  recentWorkspaces,
  workspaceKey,
  type SelectorWorkspace,
} from "./model"
import { useWorkspaceVisits } from "./visits"
import { WorkspaceTile } from "./workspace-tile"
import "./workspace-selector.css"

interface WorkspaceGalleryProps {
  workspaces: SelectorWorkspace[]
  userName: string
  userEmail?: string
  /** Shown under the headline when every workspace is reachable only through org-wide read-only access. */
  readOnlyNotice?: boolean
}

/** Greeting depends on the viewer's clock, so render a neutral one on the server and swap after hydration. */
const noopSubscribe = () => () => {}
function useGreeting(): string {
  return useSyncExternalStore(
    noopSubscribe,
    () => greetingFor(new Date().getHours()),
    () => "Welcome"
  )
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  const letters = parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]
  return letters.toUpperCase()
}

/** Pick the tile in the nearest row above/below, closest horizontally to the current one. */
function geometricMove(items: HTMLElement[], current: HTMLElement, dir: "up" | "down"): HTMLElement | null {
  const c = current.getBoundingClientRect()
  const cx = c.left + c.width / 2
  const rows = items
    .filter((t) => t !== current)
    .map((t) => ({ t, r: t.getBoundingClientRect() }))
    .filter(({ r }) => (dir === "down" ? r.top > c.top + 8 : r.top < c.top - 8))
  if (rows.length === 0) return null
  const nearest = Math.min(...rows.map(({ r }) => Math.abs(r.top - c.top)))
  return (
    rows
      .filter(({ r }) => Math.abs(r.top - c.top) - nearest < 8)
      .sort(
        (a, b) =>
          Math.abs(a.r.left + a.r.width / 2 - cx) - Math.abs(b.r.left + b.r.width / 2 - cx)
      )[0]?.t ?? null
  )
}

export function WorkspaceGallery({ workspaces, userName, userEmail, readOnlyNotice }: WorkspaceGalleryProps) {
  const [query, setQuery] = useState("")
  const visits = useWorkspaceVisits(userEmail)
  const greeting = useGreeting()
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const trimmed = query.trim()
  const filtered = useMemo(() => workspaces.filter((w) => matchesQuery(w, trimmed)), [workspaces, trimmed])
  const groups = useMemo(() => groupByOrg(filtered), [filtered])
  const totalsByOrg = useMemo(() => {
    const m = new Map<string, number>()
    for (const w of workspaces) m.set(w.orgSlug, (m.get(w.orgSlug) ?? 0) + 1)
    return m
  }, [workspaces])
  const orgCount = totalsByOrg.size

  // With four or fewer workspaces the recents row would just repeat the org grid.
  const recents = useMemo(() => recentWorkspaces(workspaces, visits, 3), [workspaces, visits])
  const showRecents = !trimmed && workspaces.length > 4 && recents.length > 0

  const firstName = userName.trim().split(/\s+/)[0] ?? ""
  const createHref = workspaces[0] ? `/${workspaces[0].orgSlug}/settings` : "/onboarding"

  const items = (): HTMLElement[] =>
    Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-wsx-item]") ?? [])

  const focusItem = (el: HTMLElement | null | undefined) => {
    if (!el) return
    el.focus()
    el.scrollIntoView({ block: "nearest", inline: "nearest" })
  }

  const clearSearch = () => {
    setQuery("")
    inputRef.current?.focus()
  }

  // ⌘K / Ctrl+K anywhere, "/" when not already typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
      const cmdK = e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)
      const slash = e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey
      if (!cmdK && !slash) return
      e.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return
    const target = e.target as HTMLElement
    const all = items()

    if (target === inputRef.current) {
      if (e.key === "ArrowDown" && all.length) {
        e.preventDefault()
        focusItem(all[0])
      } else if (e.key === "Enter" && all.length && trimmed) {
        e.preventDefault()
        all[0].click()
      } else if (e.key === "Escape" && query) {
        e.preventDefault()
        setQuery("")
      }
      return
    }

    if (!target.hasAttribute("data-wsx-item")) return
    const i = all.indexOf(target)
    let next: HTMLElement | null | undefined
    if (e.key === "ArrowRight") next = all[i + 1]
    else if (e.key === "ArrowLeft") {
      if (i <= 0) {
        e.preventDefault()
        inputRef.current?.focus()
        return
      }
      next = all[i - 1]
    } else if (e.key === "ArrowDown") next = geometricMove(all, target, "down")
    else if (e.key === "ArrowUp") {
      next = geometricMove(all, target, "up")
      if (!next) {
        e.preventDefault()
        inputRef.current?.focus()
        return
      }
    } else if (e.key === "Escape" && query) {
      e.preventDefault()
      clearSearch()
      return
    } else return
    e.preventDefault()
    focusItem(next)
  }

  const summary = trimmed
    ? `${filtered.length} of ${workspaces.length} workspaces match “${trimmed}”.`
    : `${pluralize(workspaces.length, "workspace")} across ${pluralize(orgCount, "organization")}.`

  return (
    <div className="wsx wsx-route workspace-theme-scope" ref={rootRef} onKeyDown={onKeyDown}>
      <header className="wsx-topbar">
        <Link href="/dashboard" className="wsx-brand" aria-label="Compass home">
          <span className="wsx-brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="28" height="28">
              <circle cx="16" cy="16" r="9.5" fill="none" stroke="#fff" strokeWidth="1.5" opacity=".5" />
              <path d="m20.5 11.5-2.7 6.3-6.3 2.7 2.7-6.3 6.3-2.7Z" fill="#fff" />
            </svg>
          </span>
          Compass
        </Link>

        <form className="wsx-search" role="search" data-filled={query.length > 0} onSubmit={(e) => e.preventDefault()}>
          <label className="sr-only" htmlFor="wsx-search-input">
            Search workspaces
          </label>
          <Search className="wsx-icon" aria-hidden="true" />
          <input
            id="wsx-search-input"
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search workspaces, organizations…"
            aria-controls="wsx-results"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="wsx-kbd" aria-hidden="true">
            ⌘K
          </kbd>
          {query.length > 0 && (
            <button type="button" className="wsx-search-clear" aria-label="Clear search" onClick={clearSearch}>
              <X className="wsx-icon" aria-hidden="true" />
            </button>
          )}
        </form>

        <div className="wsx-user">
          <span className="wsx-user-avatar" aria-hidden="true">
            {initialsOf(userName)}
          </span>
          <span className="wsx-user-meta">
            <strong>{userName}</strong>
            {userEmail && <span>{userEmail}</span>}
          </span>
          <form action={signOutAction}>
            <button type="submit" className="wsx-signout">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main id="main" className="wsx-body">
        <div className="wsx-page-head">
          <p className="wsx-eyebrow">{firstName ? `${greeting}, ${firstName}` : greeting}</p>
          <h1 className="wsx-display">Your workspaces</h1>
          <p className="wsx-context">{summary}</p>
          {readOnlyNotice && !trimmed && (
            <p className="wsx-context">
              You have read-only access to these workspaces through your organization.
            </p>
          )}
        </div>

        <div id="wsx-results" aria-live="polite">
          {showRecents && (
            <section className="wsx-section" aria-labelledby="wsx-h-recents">
              <div className="wsx-group-head">
                <h2 id="wsx-h-recents">Jump back in</h2>
                <span className="wsx-group-rule" />
              </div>
              <ul className="wsx-grid wsx-grid-recent">
                {recents.map((w) => (
                  <li key={workspaceKey(w)}>
                    <WorkspaceTile workspace={w} large visitedAt={visits[workspaceKey(w)]} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {groups.map((g) => (
            <section key={g.orgSlug} className="wsx-section" aria-labelledby={`wsx-h-org-${g.orgSlug}`}>
              <div className="wsx-group-head">
                <h2 id={`wsx-h-org-${g.orgSlug}`}>{g.orgName}</h2>
                <span className="wsx-group-count">
                  {trimmed
                    ? `${g.items.length} of ${totalsByOrg.get(g.orgSlug)}`
                    : pluralize(totalsByOrg.get(g.orgSlug) ?? g.items.length, "workspace")}
                </span>
                <span className="wsx-group-rule" />
                <span className="wsx-group-slug">/{g.orgSlug}</span>
              </div>
              <ul className="wsx-grid">
                {g.items.map((w) => (
                  <li key={workspaceKey(w)}>
                    <WorkspaceTile workspace={w} visitedAt={visits[workspaceKey(w)]} />
                  </li>
                ))}
              </ul>
            </section>
          ))}

          {filtered.length === 0 && (
            <div className="wsx-empty">
              <svg viewBox="0 0 96 72" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <rect x="6" y="10" width="34" height="26" rx="5" strokeDasharray="3 3" />
                <rect x="48" y="10" width="34" height="26" rx="5" strokeDasharray="3 3" />
                <circle cx="44" cy="46" r="11" fill="var(--wsx-bg)" />
                <path d="m52 54 9 9" strokeLinecap="round" />
              </svg>
              <h2>No workspaces match “{trimmed}”</h2>
              <p>Try a workspace name, or an organization like “{workspaces[0]?.orgName ?? "Acme"}”.</p>
              <button type="button" className="wsx-btn" onClick={clearSearch}>
                Clear search
              </button>
            </div>
          )}
        </div>
      </main>

      <footer className="wsx-foot">
        <div className="wsx-keys" aria-label="Keyboard shortcuts">
          <span>
            <kbd className="wsx-kbd">↑</kbd>
            <kbd className="wsx-kbd">↓</kbd>
            <kbd className="wsx-kbd">←</kbd>
            <kbd className="wsx-kbd">→</kbd> Navigate
          </span>
          <span>
            <kbd className="wsx-kbd">Enter</kbd> Open
          </span>
          <span>
            <kbd className="wsx-kbd">⌘K</kbd> or <kbd className="wsx-kbd">/</kbd> Search
          </span>
          <span>
            <kbd className="wsx-kbd">Esc</kbd> Clear
          </span>
        </div>
        <span>
          Need a new space?{" "}
          <Link href={createHref} className="wsx-link">
            <Plus className="wsx-icon inline" aria-hidden="true" /> Create workspace
          </Link>
        </span>
      </footer>
    </div>
  )
}
