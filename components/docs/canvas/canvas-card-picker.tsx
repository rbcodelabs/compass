"use client"

/**
 * Searchable picker for "Add Compass card". Search runs server-side, scoped to
 * the canvas doc's workspace and the signed-in member (searchCanvasCardItems).
 */
import { useEffect, useRef, useState } from "react"
import { Plus, Search } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { createCanvasCardItem, searchCanvasCardItems } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions"
import { CANVAS_CARD_KIND_LABELS, type CanvasCardKind } from "@/lib/canvas-cards"
import { creatableKinds, normalizeCreateTitle, type CanvasCreateKind } from "@/lib/canvas-create"
import type { CanvasCardSearchItem } from "@/lib/canvas-card-data"

export function CanvasCardPicker({
  docId,
  open,
  onOpenChange,
  onPick,
  parent,
  onCreated,
}: {
  docId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (item: CanvasCardSearchItem) => void
  /** The Compass card that was selected when the picker opened: solutions nest under an opportunity, assumptions under a solution. */
  parent?: { kind: CanvasCardKind; id: string } | null
  /** A new record was created; the editor adds its card (and the edge from `parent` when the kind nests under it). */
  onCreated: (item: { kind: CanvasCreateKind; id: string; title: string }) => void
}) {
  const [query, setQuery] = useState("")
  const [items, setItems] = useState<CanvasCardSearchItem[]>([])
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle")
  const latest = useRef(0)
  const kinds = creatableKinds(parent?.kind)
  const [createKind, setCreateKind] = useState<CanvasCreateKind>("opportunity")
  const [createTitle, setCreateTitle] = useState("")
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  // The offered kinds depend on the selection; fall back if the chosen one is no longer offered.
  const effectiveKind = kinds.includes(createKind) ? createKind : kinds[0]

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault()
    if (creating) return
    const parsed = normalizeCreateTitle(createTitle)
    if (!parsed.ok) {
      setCreateError(parsed.error)
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      const created = await createCanvasCardItem(docId, { kind: effectiveKind, title: parsed.title, parentId: parent?.id })
      onCreated(created)
      setCreateTitle("")
      setQuery("")
      setItems([])
      onOpenChange(false)
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Could not create. Try again.")
    } finally {
      setCreating(false)
    }
  }

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
          setCreateTitle("")
          setCreateError(null)
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
        <form onSubmit={handleCreate} className="space-y-2 border-t border-border-default pt-3" data-testid="canvas-card-create">
          <p className="text-xs font-medium text-text-secondary">Create new</p>
          <div className="flex items-center gap-2">
            <select
              aria-label="Kind"
              value={effectiveKind}
              onChange={(event) => setCreateKind(event.target.value as CanvasCreateKind)}
              className="h-9 shrink-0 rounded-md border border-border-default bg-transparent px-2 text-sm"
            >
              {kinds.map((kind) => (
                <option key={kind} value={kind}>{CANVAS_CARD_KIND_LABELS[kind]}</option>
              ))}
            </select>
            <input
              type="text"
              aria-label="New item title"
              placeholder="Title…"
              value={createTitle}
              maxLength={255}
              onChange={(event) => setCreateTitle(event.target.value)}
              className="h-9 min-w-0 flex-1 rounded-md border border-border-default bg-transparent px-2 text-sm outline-none"
            />
            <button
              type="submit"
              disabled={creating || !createTitle.trim()}
              className="inline-flex h-9 shrink-0 items-center gap-1 rounded-md border border-border-default px-3 text-sm hover:bg-surface-inset disabled:opacity-50"
            >
              <Plus className="size-4" aria-hidden />
              {creating ? "Creating…" : "Create"}
            </button>
          </div>
          {parent && kinds.length > 2 && <p className="text-xs text-text-subtle">Solutions and assumptions are added under the selected card.</p>}
          {createError && <p role="alert" className="text-sm text-status-danger">{createError}</p>}
        </form>
      </DialogContent>
    </Dialog>
  )
}
