"use client"

import { useLabels } from "@/components/thinking-model/thinking-model-provider"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Search, Sparkles, XIcon } from "lucide-react"

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { SidebarMenuButton } from "@/components/ui/sidebar"
import { useAgentRailOptional } from "@/components/agent/agent-rail-context"
import { buildAskText, normalizeSelection, paletteMode } from "@/lib/palette-ask-intent"
import type { WorkspaceSearchItem, WorkspaceSearchResponse } from "@/lib/workspace-search"

type SearchState = "idle" | "loading" | "ready" | "error"

const SEARCH_QUERY_MAX = 100
// Questions run longer than lookups; only the search request is capped.
const ASK_INPUT_MAX = 500

export function WorkspaceSearchPalette({ orgSlug, workspaceSlug }: { orgSlug: string; workspaceSlug: string }) {
  const router = useRouter()
  const labels = useLabels()
  // The API names its groups canonically; this screen shows the workspace's own words for the two it can rename.
  const groupLabel = (group: { type: string; label: string }) =>
    group.type === "opportunity" ? labels.opportunity.plural : group.type === "solution" ? labels.solution.plural : group.label
  const workspaceScope = `${orgSlug}:${workspaceSlug}`
  const listboxId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const requestIdRef = useRef(0)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [response, setResponse] = useState<{ scope: string; data: WorkspaceSearchResponse } | null>(null)
  const [state, setState] = useState<SearchState>("idle")
  const [activeIndex, setActiveIndex] = useState(0)
  // "Ask AI" hands off to the agent rail, which only exists inside a workspace
  // and is hidden on the full-page agent screen. Without it this is plain search.
  const rail = useAgentRailOptional()
  const askAvailable = Boolean(rail?.available)
  const [forceAsk, setForceAsk] = useState(false)
  const [selection, setSelection] = useState("")
  const openRef = useRef(false)
  const skipFinalFocusRef = useRef(false)

  const trimmedQuery = query.trim()
  const mode = askAvailable ? paletteMode({ query, forceAsk, hasSelection: Boolean(selection) }) : "search"
  const askFirst = mode === "ask"

  const currentResponse = response?.scope === workspaceScope ? response.data : null
  const items = useMemo(() => currentResponse?.groups.flatMap((group) => group.items) ?? [], [currentResponse])
  // In search-first mode the Ask row is the fallback, so it waits for results
  // rather than flashing in (and catching Enter) while a search is in flight.
  const showAskRow = askAvailable && (askFirst || (trimmedQuery.length > 0 && state !== "loading"))
  const itemOffset = showAskRow && askFirst ? 1 : 0
  const askIndex = askFirst ? 0 : items.length
  const rowCount = items.length + (showAskRow ? 1 : 0)

  useEffect(() => {
    openRef.current = open
  }, [open])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey) return
      event.preventDefault()
      // Text selected on the page becomes Ask context. Not re-read while the
      // palette is open, where the selection is inside its own input.
      if (!openRef.current) {
        setSelection(normalizeSelection(window.getSelection()?.toString() ?? ""))
        setForceAsk(false)
        skipFinalFocusRef.current = false
      }
      setOpen(true)
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [])

  useEffect(() => {
    if (!open) return
    const normalized = query.trim()
    if (normalized.length < 2 || normalized.length > SEARCH_QUERY_MAX) return

    const timer = window.setTimeout(async () => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      const requestId = ++requestIdRef.current
      setState("loading")
      try {
        const params = new URLSearchParams({ orgSlug, workspaceSlug, q: normalized })
        const result = await fetch(`/api/workspace-search?${params}`, { signal: controller.signal })
        if (!result.ok) throw new Error(`Search returned ${result.status}`)
        const next = await result.json() as WorkspaceSearchResponse
        if (requestId !== requestIdRef.current) return
        setResponse({ scope: workspaceScope, data: next })
        setActiveIndex(0)
        setState("ready")
      } catch {
        if (controller.signal.aborted || requestId !== requestIdRef.current) return
        setResponse(null)
        setState("error")
      }
    }, 200)
    return () => window.clearTimeout(timer)
  }, [open, orgSlug, query, workspaceScope, workspaceSlug])

  useEffect(() => {
    if (!open) abortRef.current?.abort()
  }, [open])

  useEffect(() => {
    abortRef.current?.abort()
    requestIdRef.current += 1
  }, [workspaceScope])

  useEffect(() => {
    document.getElementById(`${listboxId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" })
  }, [activeIndex, listboxId])

  const navigate = (item: WorkspaceSearchItem) => {
    setOpen(false)
    router.push(item.href)
  }

  const openFromTrigger = () => {
    setSelection("")
    setForceAsk(false)
    skipFinalFocusRef.current = false
    setOpen(true)
  }

  // v1 hand-off: seed the rail's composer with the question (and any selection)
  // and let the user send it there. Inline streaming would mean re-implementing
  // AgentChat's turn/stream/detached-run handling inside the palette.
  const askAgent = () => {
    if (!rail) return
    const text = buildAskText(query, selection)
    skipFinalFocusRef.current = true
    setOpen(false)
    if (!text) {
      rail.setView("agent")
      rail.openRail()
      return
    }
    rail.askAgent({
      text,
      ...(selection
        ? {
            label: "Selected text",
            summary: selection.replace(/\s+/g, " ").slice(0, 160),
            sourceUrl: window.location.pathname + window.location.search,
          }
        : {}),
    })
  }

  const handleQueryChange = (value: string) => {
    setForceAsk(false)
    abortRef.current?.abort()
    requestIdRef.current += 1
    setResponse(null)
    setActiveIndex(0)
    setQuery(value)
    const normalized = value.trim()
    setState(
      normalized.length > SEARCH_QUERY_MAX ? (askAvailable ? "idle" : "error") : normalized.length >= 2 ? "loading" : "idle",
    )
  }

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (askAvailable && event.key === "Tab" && !event.shiftKey) {
      event.preventDefault()
      setForceAsk(true)
      setActiveIndex(0)
      return
    }
    if (askAvailable && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      askAgent()
      return
    }
    if (!rowCount) return
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setActiveIndex((index) => (index + 1) % rowCount)
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setActiveIndex((index) => (index - 1 + rowCount) % rowCount)
    } else if (event.key === "Enter") {
      event.preventDefault()
      if (showAskRow && activeIndex === askIndex) {
        askAgent()
        return
      }
      const item = items[activeIndex - itemOffset]
      if (item) navigate(item)
    }
  }

  const askLabel = trimmedQuery ? `Ask AI: “${trimmedQuery}”` : selection ? "Ask about selection…" : "Ask AI anything"
  const askRow = (
    <div role="group" aria-label="Ask" className="mb-2 last:mb-0">
      <p className="px-3 py-1.5 text-xs font-medium text-muted-foreground">Ask</p>
      <div
        id={`${listboxId}-${askIndex}`}
        role="option"
        aria-selected={activeIndex === askIndex}
        onMouseMove={() => setActiveIndex(askIndex)}
        onClick={askAgent}
        className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent aria-selected:bg-accent"
      >
        <Sparkles className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-medium">{askLabel}</span>
        <kbd className="shrink-0 text-[10px] text-muted-foreground">{askFirst ? "↵" : "Tab"}</kbd>
      </div>
    </div>
  )

  return (
    <>
      <SidebarMenuButton
        ref={triggerRef}
        tooltip="Search"
        className="h-9 rounded-lg text-text-secondary"
        aria-label="Search workspace"
        onClick={openFromTrigger}
      >
        <Search className="text-text-subtle" aria-hidden="true" />
        <span>Search</span>
        <kbd className="ml-auto text-[10px] text-text-disabled group-data-[collapsible=icon]:hidden">⌘K</kbd>
      </SidebarMenuButton>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          // No z-index override: DialogContent already sits on the dialog
          // layer (70), which clears the entity detail panel layer (60).
          // This used to carry a local z-[70]/z-[80] pair, which is what
          // first broke the "nothing goes above 60" assumption that
          // select.tsx was written against.
          className="top-[18vh] block max-h-[70vh] max-w-xl translate-y-0 overflow-hidden p-0"
          initialFocus={inputRef}
          // Handing off to the rail focuses its composer; do not pull focus back.
          finalFocus={() => (skipFinalFocusRef.current ? false : triggerRef.current)}
        >
          <DialogTitle className="sr-only">Search workspace</DialogTitle>
          <DialogDescription className="sr-only">
            {askAvailable ? "Search the current workspace, or ask the Compass agent." : "Search titles in the current workspace."}
          </DialogDescription>
          <div className="flex items-center gap-3 border-b px-4">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            {askAvailable && (
              <span
                data-testid="palette-mode"
                className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${askFirst ? "border-primary/30 bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}
              >
                {askFirst ? "Ask AI" : "Search"}
              </span>
            )}
            <input
              ref={inputRef}
              role="combobox"
              aria-label="Search workspace"
              aria-controls={listboxId}
              aria-expanded={open}
              aria-activedescendant={rowCount ? `${listboxId}-${activeIndex}` : undefined}
              autoComplete="off"
              maxLength={askAvailable ? ASK_INPUT_MAX : SEARCH_QUERY_MAX + 1}
              value={query}
              onChange={(event) => handleQueryChange(event.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder={askAvailable ? "Search or ask Compass…" : `Search ${labels.opportunity.lowerPlural}, tasks, docs…`}
              className="h-14 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
            />
            <kbd className="rounded border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">ESC</kbd>
          </div>
          {selection && (
            <div className="flex items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
              <span className="shrink-0 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-primary">Context</span>
              <span className="min-w-0 flex-1 truncate">“{selection.replace(/\s+/g, " ")}”</span>
              <button
                type="button"
                aria-label="Remove selected text context"
                className="shrink-0 rounded p-0.5 hover:bg-accent"
                onClick={() => { setSelection(""); inputRef.current?.focus() }}
              >
                <XIcon className="size-3" aria-hidden="true" />
              </button>
            </div>
          )}
          <div id={listboxId} role="listbox" aria-label="Workspace search results" className="max-h-[calc(70vh-3.5rem)] overflow-y-auto p-2">
            {showAskRow && askFirst && askRow}
            {state === "idle" && trimmedQuery.length <= SEARCH_QUERY_MAX && <p className="px-3 py-8 text-center text-sm text-muted-foreground">Type at least 2 characters to search.</p>}
            {state === "loading" && <p role="status" className="px-3 py-8 text-center text-sm text-muted-foreground">Searching…</p>}
            {state === "error" && <p role="alert" className="px-3 py-8 text-center text-sm text-destructive">Search failed. Try again.</p>}
            {state === "ready" && items.length === 0 && currentResponse && <p className="px-3 py-8 text-center text-sm text-muted-foreground">No results for “{currentResponse.query}”</p>}
            {state === "ready" && currentResponse?.groups.map((group) => {
              if (!group.items.length) return null
              return (
                <div key={group.type} role="group" aria-label={groupLabel(group)} className="mb-2 last:mb-0">
                  <p className="px-3 py-1.5 text-xs font-medium text-muted-foreground">{groupLabel(group)}</p>
                  {group.items.map((item) => {
                    const index = itemOffset + items.findIndex((candidate) => candidate.type === item.type && candidate.id === item.id)
                    return (
                      <Link
                        key={`${item.type}:${item.id}`}
                        id={`${listboxId}-${index}`}
                        href={item.href}
                        role="option"
                        aria-selected={activeIndex === index}
                        onMouseMove={() => setActiveIndex(index)}
                        onClick={() => setOpen(false)}
                        className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent aria-selected:bg-accent"
                      >
                        <span className="min-w-0 truncate font-medium">{item.title}</span>
                        {item.context && <span className="shrink-0 text-xs text-muted-foreground">{item.context}</span>}
                      </Link>
                    )
                  })}
                </div>
              )
            })}
            {showAskRow && !askFirst && askRow}
          </div>
          {askAvailable && (
            <div className="flex gap-4 border-t px-4 py-2 text-[11px] text-muted-foreground">
              <span><kbd>↵</kbd> select</span>
              <span><kbd>Tab</kbd> ask AI</span>
              <span><kbd>⌘↵</kbd> open in Agent</span>
            </div>
          )}
          <div aria-live="polite" className="sr-only">
            {state === "ready" ? `${items.length} results` : state === "loading" ? "Searching" : ""}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
