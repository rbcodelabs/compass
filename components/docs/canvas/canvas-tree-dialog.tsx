"use client"

/**
 * "Build tree" dialog: pick what to draw (the whole workspace tree or everything under one item) and hand the
 * scope to the editor, which builds, lays out and merges the cards into the open canvas.
 */
import { useEffect, useRef, useState } from "react"
import { Search } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { searchCanvasCardItems } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions"
import { CANVAS_CARD_KIND_LABELS } from "@/lib/canvas-cards"
import type { CanvasCardSearchItem } from "@/lib/canvas-card-data"
import { TREE_SCOPE_KINDS, type TreeScope } from "@/lib/canvas-tree"
import { useLabels } from "@/components/thinking-model/thinking-model-provider"
import { cn } from "@/lib/utils"

export type TreeBuildOutcome = { ok: boolean; message: string }

const isTreeKind = (kind: string) => (TREE_SCOPE_KINDS as readonly string[]).includes(kind)

export function CanvasTreeDialog({
  docId,
  open,
  onOpenChange,
  onBuild,
}: {
  docId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onBuild: (scope: TreeScope) => Promise<TreeBuildOutcome>
}) {
  const labels = useLabels()
  const [mode, setMode] = useState<"workspace" | "item">("workspace")
  const [query, setQuery] = useState("")
  const [items, setItems] = useState<CanvasCardSearchItem[]>([])
  const [picked, setPicked] = useState<CanvasCardSearchItem | null>(null)
  const [searching, setSearching] = useState(false)
  const [building, setBuilding] = useState(false)
  const [outcome, setOutcome] = useState<TreeBuildOutcome | null>(null)
  const latest = useRef(0)

  useEffect(() => {
    if (!open || mode !== "item") return
    const term = query.trim()
    const requestId = ++latest.current
    const timer = setTimeout(async () => {
      if (!term) {
        setItems([])
        setSearching(false)
        return
      }
      setSearching(true)
      try {
        const found = await searchCanvasCardItems(docId, term)
        if (requestId === latest.current) setItems(found.filter((item) => isTreeKind(item.kind)))
      } catch {
        if (requestId === latest.current) setItems([])
      } finally {
        if (requestId === latest.current) setSearching(false)
      }
    }, 200)
    return () => clearTimeout(timer)
  }, [query, open, mode, docId])

  const canBuild = !building && (mode === "workspace" || picked !== null)

  async function build() {
    if (!canBuild) return
    setBuilding(true)
    setOutcome(null)
    const scope: TreeScope =
      mode === "workspace" || !picked ? { kind: "workspace" } : { kind: picked.kind as Exclude<TreeScope["kind"], "workspace">, id: picked.id }
    try {
      const result = await onBuild(scope)
      setOutcome(result)
      if (result.ok) onOpenChange(false)
    } catch {
      setOutcome({ ok: false, message: "Could not build the tree. Try again." })
    } finally {
      setBuilding(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setQuery("")
          setItems([])
          setPicked(null)
          setOutcome(null)
        }
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-w-lg" data-testid="canvas-tree-dialog">
        <DialogHeader>
          <DialogTitle>Build tree</DialogTitle>
          <DialogDescription>
            {`Adds your Compass ${labels.objective.lowerPlural}, ${labels.keyResult.lowerPlural}, ${labels.opportunity.lowerPlural}, ${labels.solution.lowerPlural}, assumptions, experiments and roadmap items as cards with their connections. ${labels.objective.plural} are grouped. Cards already on this canvas are left where they are.`}
          </DialogDescription>
        </DialogHeader>

        <div role="radiogroup" aria-label="What to build" className="grid gap-2">
          {(
            [
              ["workspace", "Whole workspace", `Every ${labels.objective.lower} and everything beneath it, plus items not under ${labels.objective.indefinite}.`],
              ["item", "From a specific item", `Only the chosen ${labels.objective.lower}, ${labels.keyResult.lower}, ${labels.opportunity.lower} or ${labels.solution.lower} and what sits beneath it.`],
            ] as const
          ).map(([value, label, hint]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              data-testid={`tree-scope-${value}`}
              onClick={() => setMode(value)}
              className={cn(
                "rounded-md border px-3 py-2 text-left text-sm transition-colors",
                mode === value ? "border-primary bg-primary/5" : "border-border-default hover:bg-surface-inset"
              )}
            >
              <div className="font-medium text-text-primary">{label}</div>
              <div className="text-xs text-text-subtle">{hint}</div>
            </button>
          ))}
        </div>

        {mode === "item" && (
          <div className="grid gap-2">
            {picked ? (
              <div className="flex items-center justify-between gap-2 rounded-md border border-border-default px-3 py-2 text-sm" data-testid="tree-picked">
                <span className="min-w-0 truncate">
                  <span className="text-text-subtle">{CANVAS_CARD_KIND_LABELS[picked.kind]}: </span>
                  {picked.title}
                </span>
                <button type="button" className="shrink-0 text-xs text-primary hover:underline" onClick={() => setPicked(null)}>
                  Change
                </button>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 rounded-md border border-border-default px-2">
                  <Search className="size-4 text-text-subtle" aria-hidden />
                  <input
                    autoFocus
                    type="text"
                    aria-label={`Search ${labels.objective.lowerPlural}, ${labels.keyResult.lowerPlural}, ${labels.opportunity.lowerPlural} and ${labels.solution.lowerPlural}`}
                    placeholder="Search by title…"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    className="h-9 w-full bg-transparent text-sm outline-none"
                  />
                </div>
                <div className="max-h-56 overflow-y-auto" data-testid="tree-scope-results">
                  {searching && items.length === 0 && <p className="p-2 text-sm text-text-subtle">Searching…</p>}
                  {!searching && query.trim() && items.length === 0 && <p className="p-2 text-sm text-text-subtle">No matches.</p>}
                  <ul>
                    {items.map((item) => (
                      <li key={`${item.kind}:${item.id}`}>
                        <button
                          type="button"
                          className="flex w-full items-center justify-between gap-3 rounded px-2 py-2 text-left text-sm hover:bg-surface-inset"
                          onClick={() => setPicked(item)}
                        >
                          <span className="min-w-0 truncate">{item.title}</span>
                          <span className="shrink-0 text-xs text-text-subtle">{CANVAS_CARD_KIND_LABELS[item.kind]}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}
          </div>
        )}

        {outcome && !outcome.ok && (
          <p role="alert" className="text-sm text-status-danger">
            {outcome.message}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="rounded px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-inset" onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button
            type="button"
            data-testid="tree-build"
            disabled={!canBuild}
            onClick={build}
            className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            {building ? "Building…" : "Build tree"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
