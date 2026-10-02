"use client"

/**
 * Searchable picker for "Add Compass card". Search runs server-side, scoped to
 * the canvas doc's workspace and the signed-in member (searchCanvasCardItems).
 */
import { useEffect, useRef, useState } from "react"
import { Search } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { searchCanvasCardItems } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions"
import { CANVAS_CARD_KIND_LABELS } from "@/lib/canvas-cards"
import type { CanvasCardSearchItem } from "@/lib/canvas-card-data"

export function CanvasCardPicker({
  docId,
  open,
  onOpenChange,
  onPick,
}: {
  docId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (item: CanvasCardSearchItem) => void
}) {
  const [query, setQuery] = useState("")
  const [items, setItems] = useState<CanvasCardSearchItem[]>([])
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle")
  const latest = useRef(0)

  useEffect(() => {
    if (!open) return
    const term = query.trim()
    const requestId = ++latest.current
    const timer = setTimeout(async () => {
      if (!term) {
        setItems([])
        setStatus("idle")
        return
      }
      setStatus("loading")
      try {
        const found = await searchCanvasCardItems(docId, term)
        if (requestId !== latest.current) return
        setItems(found)
        setStatus("idle")
      } catch {
        if (requestId === latest.current) setStatus("error")
      }
    }, 200)
    return () => clearTimeout(timer)
  }, [query, open, docId])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setQuery("")
          setItems([])
        }
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Compass card</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-md border border-border-default px-2">
          <Search className="size-4 text-text-subtle" aria-hidden />
          <input
            autoFocus
            type="text"
            aria-label="Search Compass objects"
            placeholder="Search by title…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-9 w-full bg-transparent text-sm outline-none"
          />
        </div>
        <div className="max-h-72 overflow-y-auto" data-testid="canvas-card-results">
          {status === "error" && <p role="alert" className="p-2 text-sm text-status-danger">Search failed. Try again.</p>}
          {status === "loading" && items.length === 0 && <p className="p-2 text-sm text-text-subtle">Searching…</p>}
          {status === "idle" && query.trim() && items.length === 0 && <p className="p-2 text-sm text-text-subtle">No matches.</p>}
          <ul>
            {items.map((item) => (
              <li key={`${item.kind}:${item.id}`}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 rounded px-2 py-2 text-left text-sm hover:bg-surface-inset"
                  onClick={() => {
                    onPick(item)
                    onOpenChange(false)
                  }}
                >
                  <span className="min-w-0 truncate">{item.title}</span>
                  <span className="shrink-0 text-xs text-text-subtle">
                    {CANVAS_CARD_KIND_LABELS[item.kind]}
                    {item.context ? ` · ${item.context.replace(/_/g, " ")}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  )
}
