"use client"

import { useEffect, useId, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Search } from "lucide-react"

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { SidebarMenuButton } from "@/components/ui/sidebar"
import type { WorkspaceSearchItem, WorkspaceSearchResponse } from "@/lib/workspace-search"

type SearchState = "idle" | "loading" | "ready" | "error"

export function WorkspaceSearchPalette({ orgSlug, workspaceSlug }: { orgSlug: string; workspaceSlug: string }) {
  const router = useRouter()
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

  const currentResponse = response?.scope === workspaceScope ? response.data : null
  const items = useMemo(() => currentResponse?.groups.flatMap((group) => group.items) ?? [], [currentResponse])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey) return
      event.preventDefault()
      setOpen(true)
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [])

  useEffect(() => {
    if (!open) return
    const normalized = query.trim()
    if (normalized.length < 2 || normalized.length > 100) return

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

  const handleQueryChange = (value: string) => {
    abortRef.current?.abort()
    requestIdRef.current += 1
    setResponse(null)
    setActiveIndex(0)
    setQuery(value)
    const normalized = value.trim()
    setState(normalized.length > 100 ? "error" : normalized.length >= 2 ? "loading" : "idle")
  }

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!items.length) return
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setActiveIndex((index) => (index + 1) % items.length)
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setActiveIndex((index) => (index - 1 + items.length) % items.length)
    } else if (event.key === "Enter") {
      event.preventDefault()
      navigate(items[activeIndex])
    }
  }

  return (
    <>
      <SidebarMenuButton
        ref={triggerRef}
        tooltip="Search"
        className="h-9 rounded-lg text-text-inverse/60 hover:bg-surface-navigation-active hover:text-text-inverse"
        aria-label="Search workspace"
        onClick={() => setOpen(true)}
      >
        <Search className="text-text-inverse/40" aria-hidden="true" />
        <span>Search</span>
        <kbd className="ml-auto text-[10px] text-text-inverse/35 group-data-[collapsible=icon]:hidden">⌘K</kbd>
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
          finalFocus={triggerRef}
        >
          <DialogTitle className="sr-only">Search workspace</DialogTitle>
          <DialogDescription className="sr-only">Search titles in the current workspace.</DialogDescription>
          <div className="flex items-center gap-3 border-b px-4">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              ref={inputRef}
              role="combobox"
              aria-label="Search workspace"
              aria-controls={listboxId}
              aria-expanded={open}
              aria-activedescendant={items.length ? `${listboxId}-${activeIndex}` : undefined}
              autoComplete="off"
              maxLength={101}
              value={query}
              onChange={(event) => handleQueryChange(event.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder="Search opportunities, tasks, docs…"
              className="h-14 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
            />
            <kbd className="rounded border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">ESC</kbd>
          </div>
          <div id={listboxId} role="listbox" aria-label="Workspace search results" className="max-h-[calc(70vh-3.5rem)] overflow-y-auto p-2">
            {state === "idle" && <p className="px-3 py-8 text-center text-sm text-muted-foreground">Type at least 2 characters to search.</p>}
            {state === "loading" && <p role="status" className="px-3 py-8 text-center text-sm text-muted-foreground">Searching…</p>}
            {state === "error" && <p role="alert" className="px-3 py-8 text-center text-sm text-destructive">Search failed. Try again.</p>}
            {state === "ready" && items.length === 0 && currentResponse && <p className="px-3 py-8 text-center text-sm text-muted-foreground">No results for “{currentResponse.query}”</p>}
            {state === "ready" && currentResponse?.groups.map((group) => {
              if (!group.items.length) return null
              return (
                <div key={group.type} role="group" aria-label={group.label} className="mb-2 last:mb-0">
                  <p className="px-3 py-1.5 text-xs font-medium text-muted-foreground">{group.label}</p>
                  {group.items.map((item) => {
                    const index = items.findIndex((candidate) => candidate.type === item.type && candidate.id === item.id)
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
          </div>
          <div aria-live="polite" className="sr-only">
            {state === "ready" ? `${items.length} results` : state === "loading" ? "Searching" : ""}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
