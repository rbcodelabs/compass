"use client"

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core"
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { Eye, GripVertical, Pencil, Plus, Trash2, X } from "lucide-react"
import {
  WIDGET_DEFINITIONS, WIDGET_SIZES, WIDGET_TYPES, createWidget, hasUnpublishedChanges, layoutSchema, normalizeOrder,
  type PortalHomeWidget, type WidgetSize, type WidgetType,
} from "@/lib/portal-home/schema"
import type { WidgetResolution } from "@/lib/portal-home/data"
import type { CustomerAvailability } from "@/lib/portal-home/resolve"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { StatusBadge } from "@/components/patterns/status-badge"
import { cn } from "@/lib/utils"
import { renderWidgetBody, renderWidgetForm } from "./registry"
import { BOARD_CLASS, EmptyHome, PortalHomeBoard, SIZE_CLASS } from "./board"
import type { HomeOptions } from "./types"

type Mode = "view" | "edit" | "preview"
type SaveState = "saved" | "saving" | "dirty" | "invalid" | "error"

interface Props {
  orgSlug: string
  workspaceSlug: string
  /** The customer-facing board, rendered on the server from the published layout. */
  children: ReactNode
  initialDraft: PortalHomeWidget[]
  /** What customers see right now (the published layout, or the default home). */
  initialBaseline: PortalHomeWidget[]
  publishedAt: string | null
  initialResolved: Record<string, WidgetResolution>
  /** Separate from initialResolved (team data): would each draft widget reach customers? */
  initialCustomerAvailability: Record<string, CustomerAvailability>
}

const VISIBILITY_LABEL = { everyone: "Everyone", signed_in: "Signed-in customers", segments: "Segments", team: "Team only" } as const

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } })
  const body = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`)
  return body
}

export function PortalHomeEditor({ orgSlug, workspaceSlug, children, initialDraft, initialBaseline, publishedAt: initialPublishedAt, initialResolved, initialCustomerAvailability }: Props) {
  const router = useRouter()
  const dndId = useId()
  const endpoint = `/api/portal-home/${orgSlug}/${workspaceSlug}`

  const [mode, setMode] = useState<Mode>("view")
  const [widgets, setWidgets] = useState<PortalHomeWidget[]>(initialDraft)
  const [baseline, setBaseline] = useState<PortalHomeWidget[]>(initialBaseline)
  const [publishedAt, setPublishedAt] = useState<string | null>(initialPublishedAt)
  const [resolved, setResolved] = useState<Record<string, WidgetResolution>>(initialResolved)
  const [customerAvailability, setCustomerAvailability] = useState<Record<string, CustomerAvailability>>(initialCustomerAvailability)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>("saved")
  const [message, setMessage] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [options, setOptions] = useState<HomeOptions | null>(null)
  const [preview, setPreview] = useState<{ widgets: PortalHomeWidget[]; resolved: Record<string, WidgetResolution> } | null>(null)

  const widgetsRef = useRef(widgets)
  const dirtySinceSave = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlightSave = useRef<Promise<unknown> | null>(null)

  const unpublished = hasUnpublishedChanges(widgets, baseline)
  const selected = widgets.find((widget) => widget.id === selectedId) ?? null

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const commit = useCallback((next: PortalHomeWidget[]) => {
    const ordered = normalizeOrder(next)
    setWidgets(ordered)
    setSaveState(layoutSchema.safeParse(ordered).success ? "dirty" : "invalid")
  }, [])

  // Mirror the latest draft into a ref for the async save/publish paths, and mark
  // it dirty on every real change (the untouched initial draft is never saved).
  useEffect(() => {
    widgetsRef.current = widgets
    if (widgets !== initialDraft) dirtySinceSave.current = true
  }, [widgets, initialDraft])

  const saveNow = useCallback(async (): Promise<boolean> => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    // Saves are serialized: wait for one already on the wire so two PUTs never race.
    if (inFlightSave.current) await inFlightSave.current.catch(() => undefined)
    if (!dirtySinceSave.current) return true
    const snapshot = widgetsRef.current
    if (!layoutSchema.safeParse(snapshot).success) {
      setSaveState("invalid")
      return false
    }
    setSaveState("saving")
    try {
      const request = api(endpoint, { method: "PUT", body: JSON.stringify({ widgets: snapshot }) })
      inFlightSave.current = request
      await request
      if (widgetsRef.current === snapshot) {
        dirtySinceSave.current = false
        setSaveState("saved")
      } else {
        setSaveState("dirty")
      }
      return true
    } catch (error) {
      setSaveState("error")
      setMessage(error instanceof Error ? error.message : "Could not save the draft")
      return false
    }
  }, [endpoint])

  // Debounced autosave of the draft.
  useEffect(() => {
    if (saveState !== "dirty") return
    saveTimer.current = setTimeout(() => void saveNow(), 800)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [widgets, saveState, saveNow])

  // Re-resolve data for the canvas when the draft changes (pins, links, flags).
  useEffect(() => {
    if (mode !== "edit" || !layoutSchema.safeParse(widgets).success) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      fetch(`${endpoint}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ widgets, audience: "member" }),
        signal: controller.signal,
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { resolved?: Record<string, WidgetResolution>; customerAvailability?: Record<string, CustomerAvailability> } | null) => {
          if (body?.resolved) setResolved(body.resolved)
          if (body?.customerAvailability) setCustomerAvailability(body.customerAvailability)
        })
        .catch(() => undefined)
    }, 350)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [widgets, mode, endpoint])

  // Pickers load once, when editing starts.
  useEffect(() => {
    if (mode !== "edit" || options) return
    api<HomeOptions>(`${endpoint}/options`).then(setOptions).catch(() => undefined)
  }, [mode, options, endpoint])

  const startPreview = async () => {
    if (!(await saveNow())) return
    setMode("preview")
    setPreview(null)
    try {
      const body = await api<{ widgets: PortalHomeWidget[]; resolved: Record<string, WidgetResolution> }>(`${endpoint}/resolve`, {
        method: "POST",
        body: JSON.stringify({ widgets: widgetsRef.current, audience: "customer", signedIn: false }),
      })
      setPreview(body)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not build the preview")
      setMode("edit")
    }
  }

  const publish = async () => {
    setPublishing(true)
    setMessage(null)
    try {
      if (!(await saveNow())) {
        setMessage((current) => current ?? "Fix the highlighted problems before publishing.")
        return
      }
      const result = await api<{ published: PortalHomeWidget[]; publishedAt: string }>(`${endpoint}/publish`, { method: "POST" })
      setBaseline(result.published)
      setPublishedAt(result.publishedAt)
      setMessage("Published. Customers now see this version.")
      router.refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not publish")
    } finally {
      setPublishing(false)
    }
  }

  const exitEditing = async () => {
    await saveNow()
    setMode("view")
    setSelectedId(null)
    router.refresh()
  }

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const from = widgets.findIndex((w) => w.id === active.id)
    const to = widgets.findIndex((w) => w.id === over.id)
    if (from < 0 || to < 0) return
    commit(arrayMove(widgets, from, to))
  }

  const updateWidget = (updated: PortalHomeWidget) => commit(widgets.map((w) => (w.id === updated.id ? updated : w)))
  const removeWidget = (id: string) => {
    commit(widgets.filter((w) => w.id !== id))
    setSelectedId((current) => (current === id ? null : current))
  }
  const addWidget = (type: WidgetType) => {
    const widget = createWidget(type, widgets.length)
    commit([...widgets, widget])
    setSelectedId(widget.id)
    setDrawerOpen(false)
  }

  const statusPill = useMemo(() => {
    if (saveState === "saving") return { tone: "neutral" as const, text: "Saving draft…" }
    if (saveState === "error") return { tone: "danger" as const, text: "Could not save draft" }
    if (saveState === "invalid") return { tone: "warning" as const, text: "Draft has problems" }
    if (unpublished) return { tone: "warning" as const, text: saveState === "dirty" ? "Draft · saving soon" : "Draft · unpublished changes" }
    return { tone: "success" as const, text: publishedAt ? "Published" : "Showing default home" }
  }, [saveState, unpublished, publishedAt])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-default bg-surface-panel px-4 py-3" data-testid="portal-home-admin-bar">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-text-primary">Home</span>
          <StatusBadge status={statusPill.tone} data-testid="portal-home-state">{statusPill.text}</StatusBadge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {mode === "view" ? (
            <Button type="button" onClick={() => setMode("edit")}>
              <Pencil /> Edit home
            </Button>
          ) : (
            <>
              {mode === "edit" ? (
                <Button type="button" variant="outline" onClick={() => void startPreview()}>
                  <Eye /> Preview as customer
                </Button>
              ) : (
                <Button type="button" variant="outline" onClick={() => setMode("edit")}>
                  <Pencil /> Back to editing
                </Button>
              )}
              <Button type="button" disabled={publishing || !unpublished || saveState === "invalid"} onClick={() => void publish()}>
                {publishing ? "Publishing…" : "Publish"}
              </Button>
              <Button type="button" variant="ghost" onClick={() => void exitEditing()}>
                Done
              </Button>
            </>
          )}
        </div>
      </div>

      {message ? (
        <p role="status" className="rounded-lg border border-border-default bg-surface-inset px-3 py-2 text-sm text-text-secondary">{message}</p>
      ) : null}

      {mode === "view" ? children : null}

      {mode === "preview" ? (
        <div className="flex flex-col gap-3">
          <p role="status" className="rounded-lg bg-status-info-surface px-3 py-2 text-sm text-status-info">
            Previewing as a signed-out customer. Widgets limited to signed-in customers, the team or segments, and anything not public, are hidden here exactly as they will be live.
          </p>
          {preview ? (preview.widgets.length > 0 ? <PortalHomeBoard widgets={preview.widgets} resolved={preview.resolved} /> : <EmptyHome>Customers would see an empty home.</EmptyHome>) : <EmptyHome>Building preview…</EmptyHome>}
        </div>
      ) : null}

      {mode === "edit" ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="flex min-w-0 flex-col gap-4">
            <p className="text-sm text-text-secondary">
              <strong className="text-text-primary">Editing home.</strong> Drag the handle to reorder, pick a size, or select a widget to configure it. Customers see the published version until you publish.
            </p>
            <DndContext id={dndId} sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={widgets.map((w) => w.id)} strategy={rectSortingStrategy}>
                <div className={BOARD_CLASS} data-testid="portal-home-edit-board">
                  {widgets.map((widget) => (
                    <EditableWidget
                      key={widget.id}
                      widget={widget}
                      resolution={resolved[widget.id]}
                      customerAvailability={customerAvailability[widget.id]}
                      selected={widget.id === selectedId}
                      onSelect={() => setSelectedId(widget.id)}
                      onSize={(size) => updateWidget({ ...widget, size })}
                    />
                  ))}
                  <button
                    type="button"
                    onClick={() => setDrawerOpen(true)}
                    className="flex min-h-24 items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong text-sm font-medium text-text-subtle hover:bg-surface-inset md:col-span-6"
                  >
                    <Plus className="size-4" /> Add widget
                  </button>
                </div>
              </SortableContext>
            </DndContext>
          </div>

          <aside aria-label="Widget settings" className="flex h-fit flex-col gap-4 rounded-xl border border-border-default bg-surface-panel p-4 lg:sticky lg:top-4">
            {selected ? (
              <>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className="text-xs font-semibold tracking-wide text-text-subtle uppercase">Selected widget</span>
                    <h2 className="text-base font-semibold text-text-primary">{WIDGET_DEFINITIONS[selected.type].label}</h2>
                  </div>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="Deselect widget" onClick={() => setSelectedId(null)}>
                    <X />
                  </Button>
                </div>
                {renderWidgetForm(selected, updateWidget, options)}
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-1 text-sm font-medium text-text-primary">Visible to</legend>
                  {(["everyone", "signed_in", "team", "segments"] as const).map((value) => (
                    <label key={value} className={cn("flex items-center gap-2 text-sm", value === "segments" && "text-text-disabled")}>
                      <input
                        type="radio"
                        name={`visibility-${selected.id}`}
                        value={value}
                        checked={selected.visibility === value}
                        disabled={value === "segments" && selected.visibility !== "segments"}
                        onChange={() => updateWidget({ ...selected, visibility: value })}
                        className="accent-[var(--color-primary)]"
                      />
                      {VISIBILITY_LABEL[value]}
                      {value === "segments" ? <span className="text-xs">(coming soon)</span> : null}
                    </label>
                  ))}
                  {selected.visibility === "segments" ? (
                    <p className="text-xs leading-5 text-status-warning">Segments are not available yet, so no customer sees this widget. Pick Everyone or Signed-in customers.</p>
                  ) : null}
                  <p className="text-xs leading-5 text-text-subtle">Team only widgets show on the team Home tab and are never sent to customers. Enforced on the server. Items you have not made public never appear to customers, even if pinned here.</p>
                </fieldset>
                <Button type="button" variant="destructive" onClick={() => removeWidget(selected.id)}>
                  <Trash2 /> Remove widget
                </Button>
              </>
            ) : (
              <p className="text-sm leading-6 text-text-subtle">Select a widget to change its content, size, and who can see it.</p>
            )}
          </aside>
        </div>
      ) : null}

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="right" className="w-full p-4 sm:max-w-sm">
          <SheetHeader className="p-0">
            <SheetTitle>Add widget</SheetTitle>
            <SheetDescription>Choose a widget to add to the end of your home.</SheetDescription>
          </SheetHeader>
          <ul className="flex flex-col gap-2 overflow-y-auto">
            {WIDGET_TYPES.map((type) => (
              <li key={type}>
                <button
                  type="button"
                  onClick={() => addWidget(type)}
                  className="flex w-full flex-col gap-0.5 rounded-lg border border-border-default p-3 text-left hover:bg-surface-inset focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <span className="text-sm font-medium text-text-primary">{WIDGET_DEFINITIONS[type].label}</span>
                  <span className="text-xs text-text-subtle">{WIDGET_DEFINITIONS[type].description}</span>
                </button>
              </li>
            ))}
          </ul>
        </SheetContent>
      </Sheet>
    </div>
  )
}

function EditableWidget({
  widget, resolution, customerAvailability, selected, onSelect, onSize,
}: { widget: PortalHomeWidget; resolution: WidgetResolution | undefined; customerAvailability: CustomerAvailability | undefined; selected: boolean; onSelect: () => void; onSize: (size: WidgetSize) => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: widget.id })
  const body = resolution?.available ? renderWidgetBody(widget, resolution) : null
  return (
    <section
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      aria-label={`${WIDGET_DEFINITIONS[widget.type].label} widget`}
      data-widget-type={widget.type}
      className={cn("min-w-0 rounded-xl", SIZE_CLASS[widget.size], isDragging && "z-10 opacity-80", selected && "ring-2 ring-ring")}
    >
      <div className="flex flex-wrap items-center gap-2 rounded-t-xl border border-b-0 border-border-default bg-surface-inset px-2 py-1.5">
        <button
          type="button"
          ref={setActivatorNodeRef}
          aria-label={`Drag to reorder ${WIDGET_DEFINITIONS[widget.type].label}`}
          className="cursor-grab touch-none rounded p-1 text-text-subtle hover:bg-muted"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </button>
        <button type="button" onClick={onSelect} aria-pressed={selected} className="mr-auto rounded px-1 text-xs font-medium text-text-primary hover:underline">
          {WIDGET_DEFINITIONS[widget.type].label}
        </button>
        {widget.visibility !== "everyone" ? <StatusBadge status={widget.visibility === "segments" ? "warning" : "info"}>{VISIBILITY_LABEL[widget.visibility]}</StatusBadge> : null}
        {customerAvailability && !customerAvailability.shown ? (
          <StatusBadge status="warning">Not shown to customers: {customerAvailability.reason}</StatusBadge>
        ) : null}
        <div role="group" aria-label="Size" className="inline-flex overflow-hidden rounded-md border border-border-default">
          {WIDGET_SIZES.map((size) => (
            <button
              key={size}
              type="button"
              aria-pressed={widget.size === size}
              aria-label={`Size ${size}`}
              onClick={() => onSize(size)}
              className={cn("h-6 w-7 text-xs font-medium", widget.size === size ? "bg-primary text-primary-foreground" : "bg-surface-panel text-text-secondary hover:bg-muted")}
            >
              {size}
            </button>
          ))}
        </div>
      </div>
      <div onClick={onSelect} className="cursor-pointer [&>div]:rounded-t-none">
        {body ?? (
          <div className="flex h-full min-h-24 flex-col justify-center gap-1 rounded-b-xl border border-dashed border-border-strong bg-surface-inset p-4 text-sm text-text-subtle">
            <strong className="text-text-secondary">Nothing to show</strong>
            <span>{resolution && !resolution.available ? resolution.reason : "Loading…"}</span>
          </div>
        )}
      </div>
    </section>
  )
}
