"use client"

/**
 * JSON Canvas doc editor (React Flow + the JSON Canvas mapping layer in
 * lib/json-canvas-flow.ts).
 *
 * Persistence deliberately reuses the regular doc update path: the canvas is
 * serialized to JSON and saved with the `updateDoc` server action through the
 * same revision-aware save queue as the markdown editor, so DocVersion
 * snapshots, revision-conflict handling, and Retry behave identically.
 *
 * Undo/redo: every committed gesture (drag end, resize end, connect, add,
 * delete, text/color/label edit) pushes an immutable JSON Canvas snapshot onto
 * lib/json-canvas-history; undo/redo reload a snapshot and autosave it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import {
  Background,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import {
  BookmarkPlus,
  Boxes,
  Download,
  FileText,
  History,
  Link2,
  ListTree,
  Lock,
  LockOpen,
  Redo2,
  Square,
  StickyNote,
  Trash2,
  Undo2,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  createDocVersion,
  restoreDocVersion,
  updateDoc,
} from "@/app/[orgSlug]/[workspaceSlug]/docs/actions"
import { createDocumentSaveQueue } from "@/lib/document-save-queue"
import { buildCanvasTree, resolveCanvasCardRefs } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions"
import { useLabels } from "@/components/thinking-model/thinking-model-provider"
import { CanvasTreeDialog, type TreeBuildOutcome } from "@/components/docs/canvas/canvas-tree-dialog"
import { mergeTreeIntoCanvas, MAX_TREE_CARDS, type TreeScope } from "@/lib/canvas-tree"
import { layoutTreeCards } from "@/lib/canvas-tree-layout"
import { CanvasCardPicker } from "@/components/docs/canvas/canvas-card-picker"
import {
  CANVAS_CARD_DRAG_TYPE,
  MAX_CARD_REFS,
  canvasCardKey,
  createCanvasCardNode,
  decodeCanvasCard,
  isCanvasCardRef,
  type CanvasCardRef,
} from "@/lib/canvas-cards"
import type { CanvasCardView } from "@/lib/canvas-card-data"
import { DocVersionHistoryPanel, type DocVersionListItem } from "@/components/docs/doc-version-history-panel"
import type { PanelPin } from "@/lib/panel-pin"
import {
  CANVAS_PRESET_COLORS,
  isValidCanvasColor,
  normalizeCanvasContent,
  parseJsonCanvas,
  serializeJsonCanvas,
  type CanvasNodeType,
  type JsonCanvas,
  type JsonCanvasEdge,
  type JsonCanvasNode,
} from "@/lib/json-canvas"
import {
  createCanvasNode,
  edgeToFlow,
  fromFlow,
  newCanvasId,
  nodeToFlow,
  refreshAutoSides,
  toFlow,
  type FlowEdge,
  type FlowNode,
} from "@/lib/json-canvas-flow"
import { Checkbox } from "@/components/ui/checkbox"
import { createHistory } from "@/lib/json-canvas-history"
import { canvasNodeTypes, CanvasUiContext, type CanvasUi } from "@/components/docs/canvas/canvas-nodes"

interface CanvasDocEditorProps {
  doc: { id: string; title: string; content: string | null; icon: string | null; revision?: string | null }
  versions: DocVersionListItem[]
  revalidatePathStr: string
  initialHistoryPin?: PanelPin
  decisionAction?: React.ReactNode
}

type SaveStatus = "idle" | "saving" | "saved" | "error"
type SaveChange =
  | { kind: "update"; data: { title?: string; content?: string } }
  | { kind: "snapshot"; label?: string }
  | { kind: "restore"; versionId: string; onDone: (result: Awaited<ReturnType<typeof restoreDocVersion>>) => void }

const SAVE_DEBOUNCE_MS = 1200

const NARROW_QUERY = "(max-width: 767px)"
function subscribeNarrowViewport(onChange: () => void) {
  const query = window.matchMedia(NARROW_QUERY)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}
function getNarrowViewport() {
  return window.matchMedia(NARROW_QUERY).matches
}

export function CanvasDocEditor(props: CanvasDocEditorProps) {
  return (
    <ReactFlowProvider>
      <CanvasSurface {...props} />
    </ReactFlowProvider>
  )
}

function CanvasSurface({ doc, versions, revalidatePathStr, initialHistoryPin, decisionAction }: CanvasDocEditorProps) {
  const initial = useMemo(() => normalizeCanvasContent(doc.content ?? ""), [doc.content])
  if (!initial.ok) {
    return (
      <div role="alert" className="m-8 max-w-xl rounded-lg border border-status-danger/40 p-4 text-sm text-status-danger">
        This canvas could not be read, so it is shown read-only to avoid overwriting it. {initial.error}
      </div>
    )
  }
  return (
    <CanvasEditorBody
      doc={doc}
      initialCanvas={initial.canvas}
      versions={versions}
      revalidatePathStr={revalidatePathStr}
      initialHistoryPin={initialHistoryPin}
      decisionAction={decisionAction}
    />
  )
}

function CanvasEditorBody({
  doc,
  initialCanvas,
  versions,
  revalidatePathStr,
  initialHistoryPin,
  decisionAction,
}: Omit<CanvasDocEditorProps, never> & { initialCanvas: JsonCanvas }) {
  const flow = useReactFlow()
  const wrapperRef = useRef<HTMLDivElement>(null)

  const [title, setTitle] = useState(doc.title)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle")
  const [saveError, setSaveError] = useState<string | null>(null)
  const [isRestoring, setIsRestoring] = useState(false)
  // Phones get a view-first canvas; the lock button overrides the default either way.
  const isNarrow = useSyncExternalStore(subscribeNarrowViewport, getNarrowViewport, () => false)
  const [lockOverride, setLockOverride] = useState<boolean | null>(null)
  const readOnly = lockOverride ?? isNarrow
  const locked = readOnly || isRestoring
  const [editingId, setEditingId] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const labels = useLabels()
  const [treeOpen, setTreeOpen] = useState(false)
  const [treeNotice, setTreeNotice] = useState<string | null>(null)
  const [cardViews, setCardViews] = useState<Record<string, CanvasCardView>>({})
  const [historyOpen, setHistoryOpen] = useState(false)
  const [showSaveVersionInput, setShowSaveVersionInput] = useState(false)
  const [currentContent, setCurrentContent] = useState(() => serializeJsonCanvas(initialCanvas))
  const [, bumpHistory] = useState(0)

  const [initialFlow] = useState(() => toFlow(initialCanvas))
  const [nodes, setNodesState] = useState<FlowNode[]>(initialFlow.nodes)
  const [edges, setEdgesState] = useState<FlowEdge[]>(initialFlow.edges)
  // Refs mirror the latest graph so gesture-end handlers never read stale state.
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  const baseRef = useRef<JsonCanvas>(initialCanvas)
  const latestCanvasRef = useRef<JsonCanvas>(initialCanvas)
  const [history] = useState(() => createHistory<JsonCanvas>(initialCanvas))

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingContent = useRef<string | null>(null)


  // ── Autosave through the regular doc update path ────────────────────────────
  const saveQueue = useMemo(
    () =>
      // The queue's callbacks only touch refs when invoked (never during render).
      // eslint-disable-next-line react-hooks/refs
      createDocumentSaveQueue<SaveChange>({
        revision: doc.revision,
        execute: async (change, token) => {
          if (change.kind === "snapshot") {
            await createDocVersion(doc.id, change.label, revalidatePathStr, token)
            return {}
          }
          if (change.kind === "restore") {
            setIsRestoring(true)
            try {
              const restored = await restoreDocVersion(change.versionId, revalidatePathStr, token)
              change.onDone(restored)
              return restored
            } finally {
              setIsRestoring(false)
            }
          }
          return updateDoc(doc.id, change.data, revalidatePathStr, token)
        },
        onState: (state) => {
          setSaveStatus(state === "saved" && pendingContent.current !== null ? "saving" : state)
          setSaveError(
            state === "error"
              ? "Changes could not be saved. Your canvas is still here. Retry; if another editor changed this page, export your canvas before reloading."
              : null
          )
        },
      }),
    // A server revalidation must not replace the queue's revision or unsaved draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.id, revalidatePathStr]
  )

  const flushContent = useCallback(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = null
    if (pendingContent.current === null) return
    const content = pendingContent.current
    pendingContent.current = null
    void saveQueue.enqueue({ kind: "update", data: { content } }).catch(() => {})
  }, [saveQueue])

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (pendingContent.current !== null || saveQueue.pending()) {
        event.preventDefault()
        event.returnValue = ""
      }
    }
    window.addEventListener("beforeunload", warn)
    return () => {
      window.removeEventListener("beforeunload", warn)
      flushContent()
    }
  }, [saveQueue, flushContent])

  const scheduleSave = useCallback(
    (canvas: JsonCanvas) => {
      const content = serializeJsonCanvas(canvas)
      pendingContent.current = content
      setCurrentContent(content)
      setSaveStatus("saving")
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
      debounceTimer.current = setTimeout(flushContent, SAVE_DEBOUNCE_MS)
    },
    [flushContent]
  )

  // ── Graph state helpers ─────────────────────────────────────────────────────
  const setGraph = useCallback((nextNodes: FlowNode[], nextEdges: FlowEdge[]) => {
    nodesRef.current = nextNodes
    edgesRef.current = nextEdges
    setNodesState(nextNodes)
    setEdgesState(nextEdges)
  }, [])

  /** Record a committed change: update graph, push history, autosave. */
  const commit = useCallback(
    (nextNodes: FlowNode[], nextEdges: FlowEdge[]) => {
      const refreshed = refreshAutoSides(nextNodes, nextEdges)
      setGraph(nextNodes, refreshed)
      const canvas = fromFlow(baseRef.current, nextNodes, refreshed)
      latestCanvasRef.current = canvas
      history.push(canvas)
      bumpHistory((n) => n + 1)
      scheduleSave(canvas)
    },
    [history, scheduleSave, setGraph]
  )

  const loadCanvas = useCallback(
    (canvas: JsonCanvas, options: { save: boolean }) => {
      const next = toFlow(canvas)
      baseRef.current = canvas
      latestCanvasRef.current = canvas
      setGraph(next.nodes, next.edges)
      setEditingId(null)
      bumpHistory((n) => n + 1)
      if (options.save) scheduleSave(canvas)
      else setCurrentContent(serializeJsonCanvas(canvas))
    },
    [scheduleSave, setGraph]
  )

  const undo = useCallback(() => {
    const previous = history.undo()
    if (previous) loadCanvas(previous, { save: true })
  }, [history, loadCanvas])
  const redo = useCallback(() => {
    const next = history.redo()
    if (next) loadCanvas(next, { save: true })
  }, [history, loadCanvas])

  // ── React Flow event wiring ─────────────────────────────────────────────────
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setGraph(applyNodeChanges(changes, nodesRef.current as unknown as Node[]) as unknown as FlowNode[], edgesRef.current)
    },
    [setGraph]
  )
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setGraph(nodesRef.current, applyEdgeChanges(changes, edgesRef.current as unknown as Edge[]) as unknown as FlowEdge[])
    },
    [setGraph]
  )

  const onNodeDragStop = useCallback(() => commit(nodesRef.current, edgesRef.current), [commit])

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.sourceHandle || !connection.targetHandle || connection.source === connection.target) return
      const raw: JsonCanvasEdge = {
        id: newCanvasId(),
        fromNode: connection.source,
        toNode: connection.target,
        fromSide: connection.sourceHandle as JsonCanvasEdge["fromSide"],
        toSide: connection.targetHandle as JsonCanvasEdge["toSide"],
      }
      commit(nodesRef.current, [...edgesRef.current, edgeToFlow(raw, nodesRef.current)])
    },
    [commit]
  )

  const onDelete = useCallback(
    ({ nodes: removedNodes, edges: removedEdges }: { nodes: Node[]; edges: Edge[] }) => {
      const nodeIds = new Set(removedNodes.map((n) => n.id))
      const edgeIds = new Set(removedEdges.map((e) => e.id))
      commit(
        nodesRef.current.filter((n) => !nodeIds.has(n.id)),
        edgesRef.current.filter((e) => !edgeIds.has(e.id) && !nodeIds.has(e.source) && !nodeIds.has(e.target))
      )
    },
    [commit]
  )

  // ── Editing operations ──────────────────────────────────────────────────────
  const patchNode = useCallback(
    (id: string, patch: Partial<JsonCanvasNode>) => {
      commit(
        nodesRef.current.map((node) => {
          if (node.id !== id) return node
          const raw: JsonCanvasNode = { ...node.data.raw, ...patch }
          for (const key of Object.keys(patch)) if (patch[key] === undefined) delete raw[key]
          return { ...node, data: { raw } }
        }),
        edgesRef.current
      )
    },
    [commit]
  )

  const patchEdge = useCallback(
    (id: string, patch: Partial<JsonCanvasEdge>) => {
      commit(
        nodesRef.current,
        edgesRef.current.map((edge) => {
          if (edge.id !== id) return edge
          const raw: JsonCanvasEdge = { ...edge.data.raw, ...patch }
          for (const key of Object.keys(patch)) if (patch[key] === undefined) delete raw[key]
          // Explicit sides chosen by the user stay in raw; re-derive the rest from it.
          const withSides: JsonCanvasEdge = {
            ...raw,
            ...(edge.data.autoFrom ? {} : { fromSide: edge.sourceHandle }),
            ...(edge.data.autoTo ? {} : { toSide: edge.targetHandle }),
          }
          return { ...edgeToFlow(withSides, nodesRef.current), selected: edge.selected }
        })
      )
    },
    [commit]
  )

  /** Insert a new node centered on `at` (flow coordinates, default: viewport center). */
  const insertNode = useCallback(
    (raw: JsonCanvasNode, options: { at?: { x: number; y: number }; edit?: boolean } = {}) => {
      const rect = wrapperRef.current?.getBoundingClientRect()
      const center =
        options.at ??
        (rect
          ? flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
          : { x: 0, y: 0 })
      // Stagger successive cards so they do not stack exactly on top of each other.
      const stagger = options.at ? 0 : (nodesRef.current.length % 8) * 32
      raw.x = Math.round(center.x - raw.width / 2 + stagger)
      raw.y = Math.round(center.y - raw.height / 2 + stagger)
      const created: FlowNode = { ...nodeToFlow(raw), selected: true }
      commit(
        [...nodesRef.current.map((n) => ({ ...n, selected: false })), created],
        edgesRef.current.map((e) => ({ ...e, selected: false }))
      )
      setEditingId(options.edit ? raw.id : null)
    },
    [commit, flow]
  )

  const addNode = useCallback(
    (type: CanvasNodeType) => insertNode(createCanvasNode(type, { x: 0, y: 0 }), { edit: type !== "group" }),
    [insertNode]
  )

  const addCard = useCallback(
    (ref: CanvasCardRef, title: string | undefined, at?: { x: number; y: number }) =>
      insertNode(createCanvasCardNode(newCanvasId(), ref, title, { x: 0, y: 0 }), { at }),
    [insertNode]
  )

  // Cards dragged from the page tree (see doc-tree-sidebar.tsx) drop onto the canvas.
  const onCanvasDragOver = useCallback(
    (event: React.DragEvent) => {
      if (!locked && event.dataTransfer.types.includes(CANVAS_CARD_DRAG_TYPE)) {
        event.preventDefault()
        event.dataTransfer.dropEffect = "copy"
      }
    },
    [locked]
  )
  const onCanvasDrop = useCallback(
    (event: React.DragEvent) => {
      if (locked) return
      const payload = event.dataTransfer.getData(CANVAS_CARD_DRAG_TYPE)
      if (!payload) return
      event.preventDefault()
      try {
        const parsed = JSON.parse(payload) as { kind?: unknown; id?: unknown; title?: unknown }
        const ref = { kind: parsed.kind, id: parsed.id }
        if (!isCanvasCardRef(ref)) return
        addCard(ref, typeof parsed.title === "string" ? parsed.title : undefined, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }))
      } catch {
        /* malformed drag payload: ignore */
      }
    },
    [addCard, flow, locked]
  )

  const deleteSelection = useCallback(() => {
    const removedNodes = nodesRef.current.filter((n) => n.selected)
    const removedEdges = edgesRef.current.filter((e) => e.selected)
    if (!removedNodes.length && !removedEdges.length) return
    onDelete({ nodes: removedNodes as unknown as Node[], edges: removedEdges as unknown as Edge[] })
  }, [onDelete])

  // Live Compass cards: references are re-resolved on the server (authorized per
  // viewer) whenever the set of referenced objects changes. Never trusted client-side.
  const cardRefsKey = useMemo(
    () =>
      nodes
        .flatMap((n) => {
          const card = decodeCanvasCard(n.data.raw)
          return card ? [canvasCardKey(card)] : []
        })
        .sort()
        .join(","),
    [nodes]
  )
  useEffect(() => {
    if (!cardRefsKey) return
    const refs = cardRefsKey.split(",").map((key) => {
      const [kind, id] = key.split(":")
      return { kind, id }
    })
    let cancelled = false
    // The server resolves at most MAX_CARD_REFS per request, so a large canvas (e.g. a built tree) goes in batches.
    for (let i = 0; i < refs.length; i += MAX_CARD_REFS) {
      resolveCanvasCardRefs(doc.id, refs.slice(i, i + MAX_CARD_REFS))
        .then((views) => {
          if (!cancelled) setCardViews((prev) => ({ ...prev, ...(views as Record<string, CanvasCardView>) }))
        })
        .catch(() => {
          /* leave cards on their cached titles; the next change retries */
        })
    }
    return () => {
      cancelled = true
    }
  }, [cardRefsKey, doc.id])

  /** Build the OST tree on the server, lay it out here, merge it into the open canvas as one undoable step. */
  const handleBuildTree = useCallback(
    async (scope: TreeScope): Promise<TreeBuildOutcome> => {
      const fragment = await buildCanvasTree(doc.id, scope)
      if (fragment.cards.length === 0) {
        return { ok: false, message: scope.kind === "workspace" ? "There is nothing in this workspace to draw yet." : "Nothing sits beneath that item yet." }
      }
      let positions: Awaited<ReturnType<typeof layoutTreeCards>>
      try {
        positions = await layoutTreeCards(fragment.cards, fragment.edges)
      } catch {
        positions = new Map() // merge falls back to a simple column, so a layout failure still yields a usable canvas
      }
      const current = fromFlow(baseRef.current, nodesRef.current, edgesRef.current)
      const merged = mergeTreeIntoCanvas(current, fragment, positions, newCanvasId)
      if (!merged.ok) return { ok: false, message: "This canvas is too large to add the tree. Build into a new canvas, or start from a smaller item." }
      if (merged.addedCards === 0) return { ok: false, message: "Everything in that tree is already on this canvas." }
      const next = toFlow(merged.canvas)
      commit(next.nodes, next.edges)
      const added = new Set(merged.canvas.nodes.slice(current.nodes.length).map((n) => n.id))
      requestAnimationFrame(() => flow.fitView({ nodes: [...added].map((id) => ({ id })), padding: 0.15, duration: 300 }))
      setTreeNotice(
        `Added ${merged.addedCards} card${merged.addedCards === 1 ? "" : "s"}${merged.addedGroups ? ` in ${merged.addedGroups} group${merged.addedGroups === 1 ? "" : "s"}` : ""}` +
          (fragment.truncated ? `. The tree is larger than ${MAX_TREE_CARDS} cards, so only the top of it was drawn. Build again from a specific item to see the rest.` : ".")
      )
      return { ok: true, message: "" }
    },
    [commit, doc.id, flow]
  )

  const ui = useMemo<CanvasUi>(
    () => ({
      readOnly: locked,
      editingId,
      setEditingId,
      patchNode,
      onResizeEnd: () => commit(nodesRef.current, edgesRef.current),
      cards: cardViews,
    }),
    [locked, editingId, patchNode, commit, cardViews]
  )

  // ── Title, versions, export ─────────────────────────────────────────────────
  async function handleSaveTitle() {
    if (title === doc.title) return
    await saveQueue.enqueue({ kind: "update", data: { title } }).catch(() => {})
  }

  async function handleSaveVersion(label: string) {
    flushContent()
    try {
      await saveQueue.enqueue({ kind: "snapshot", label: label || undefined })
      setShowSaveVersionInput(false)
    } catch {
      // The queue keeps the failed operation for the Retry button.
    }
  }

  function handleExport() {
    const blob = new Blob([serializeJsonCanvas(latestCanvasRef.current)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    const safeName = (title || "canvas").replace(/[\\/:*?"<>|]+/g, "-").trim() || "canvas"
    link.href = url
    link.download = `${safeName}.canvas`
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  function handleRestored(content: string | null, restoredTitle: string) {
    const parsed = parseJsonCanvas(content ?? "{}")
    if (parsed.ok) {
      history.push(parsed.canvas)
      loadCanvas(parsed.canvas, { save: false })
    }
    setTitle(restoredTitle)
  }

  // ── Selection inspector ─────────────────────────────────────────────────────
  const selectedNode = nodes.find((n) => n.selected)
  const selectedEdge = !selectedNode ? edges.find((e) => e.selected) : undefined
  const inspectorColor = selectedNode?.data.raw.color ?? selectedEdge?.data.raw.color
  function onKeyDown(event: React.KeyboardEvent) {
    const target = event.target as HTMLElement
    if (target.closest("input, textarea, [contenteditable=true]")) return
    const meta = event.metaKey || event.ctrlKey
    if (meta && event.key.toLowerCase() === "z") {
      event.preventDefault()
      if (event.shiftKey) redo()
      else undo()
    } else if (meta && event.key.toLowerCase() === "y") {
      event.preventDefault()
      redo()
    }
  }

  return (
    <div
      className="flex h-full min-h-[520px] min-w-0 flex-col"
      data-testid="canvas-doc-editor"
      onKeyDown={onKeyDown}
    >
      <div className="flex min-h-7 justify-end px-4 pt-3 sm:px-8">
        {saveStatus === "saving" && <span className="text-xs text-text-subtle">Saving…</span>}
        {saveStatus === "saved" && <span className="text-xs text-text-subtle">Saved</span>}
        {saveError && (
          <span role="alert" className="text-xs text-status-danger">
            {saveError}{" "}
            <button type="button" className="underline" onClick={() => void saveQueue.retry()}>
              Retry save
            </button>
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 px-4 pb-2 sm:px-8">
        <input
          disabled={isRestoring}
          type="text"
          value={title}
          aria-label="Canvas title"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={handleSaveTitle}
          placeholder="Untitled canvas"
          className="min-w-0 flex-1 border-none bg-transparent text-2xl font-bold text-text-primary outline-none placeholder:text-text-disabled"
        />
      </div>

      {/* Toolbar: scrolls horizontally on narrow screens instead of wrapping or squashing. */}
      <div className="sticky top-0 z-10 flex items-center gap-1 border-b border-border-default bg-surface-panel/90 px-4 py-1.5 backdrop-blur-sm sm:px-8">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <ToolButton label="Add text card" disabled={locked} onClick={() => addNode("text")}>
            <StickyNote className="size-4" />
            <span className="hidden lg:inline">Text</span>
          </ToolButton>
          <ToolButton label="Add link card" disabled={locked} onClick={() => addNode("link")}>
            <Link2 className="size-4" />
            <span className="hidden lg:inline">Link</span>
          </ToolButton>
          <ToolButton label="Add file card" disabled={locked} onClick={() => addNode("file")}>
            <FileText className="size-4" />
            <span className="hidden lg:inline">File</span>
          </ToolButton>
          <ToolButton label="Add Compass card" disabled={locked} onClick={() => setPickerOpen(true)}>
            <Boxes className="size-4" />
            <span className="hidden lg:inline">Compass</span>
          </ToolButton>
          <ToolButton label={`Build tree from Compass ${labels.objective.lowerPlural}`} disabled={locked} onClick={() => setTreeOpen(true)}>
            <ListTree className="size-4" />
            <span className="hidden lg:inline">Tree</span>
          </ToolButton>
          <ToolButton label="Add group" disabled={locked} onClick={() => addNode("group")}>
            <Square className="size-4" />
            <span className="hidden lg:inline">Group</span>
          </ToolButton>
          <Divider />
          <ToolButton label="Undo" disabled={locked || !history.canUndo()} onClick={undo}>
            <Undo2 className="size-4" />
          </ToolButton>
          <ToolButton label="Redo" disabled={locked || !history.canRedo()} onClick={redo}>
            <Redo2 className="size-4" />
          </ToolButton>
          <ToolButton
            label="Delete selection"
            disabled={locked || (!selectedNode && !selectedEdge)}
            onClick={deleteSelection}
          >
            <Trash2 className="size-4" />
          </ToolButton>
          <Divider />
          <ToolButton
            label={readOnly ? "Unlock editing" : "Lock editing"}
            pressed={readOnly}
            onClick={() => {
              setEditingId(null)
              setLockOverride(!readOnly)
            }}
          >
            {readOnly ? <Lock className="size-4" /> : <LockOpen className="size-4" />}
          </ToolButton>
          <ToolButton label="Export .canvas" onClick={handleExport}>
            <Download className="size-4" />
            <span className="hidden lg:inline">Export</span>
          </ToolButton>
        </div>
        <Divider />
        <ToolButton label="Version history" onClick={() => setHistoryOpen(true)}>
          <History className="size-4" />
        </ToolButton>
        <div className="relative shrink-0">
          <ToolButton label="Save named version" onClick={() => setShowSaveVersionInput((v) => !v)}>
            <BookmarkPlus className="size-4" />
          </ToolButton>
          {showSaveVersionInput && (
            <div className="absolute right-0 z-20 mt-1 flex items-center gap-1.5 rounded-lg border border-border-default bg-surface-card p-2 shadow-md">
              <input
                type="text"
                autoFocus
                placeholder="Label (optional)"
                className="w-40 rounded border border-border-default px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-border-focus"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSaveVersion(e.currentTarget.value)
                  if (e.key === "Escape") setShowSaveVersionInput(false)
                }}
              />
            </div>
          )}
        </div>
        {decisionAction && <div className="shrink-0 pl-1">{decisionAction}</div>}
      </div>

      {/* Selection inspector: color for nodes/edges, label and arrowheads for edges. */}
      {(selectedNode || selectedEdge) && !locked && (
        <div
          data-testid="canvas-inspector"
          className="flex items-center gap-3 overflow-x-auto border-b border-border-default bg-surface-panel px-4 py-1.5 text-xs sm:px-8"
        >
          <ColorPicker
            value={inspectorColor}
            onChange={(color) =>
              selectedNode ? patchNode(selectedNode.id, { color }) : selectedEdge && patchEdge(selectedEdge.id, { color })
            }
          />
          {selectedEdge && (
            <>
              <Divider />
              <EdgeLabelInput
                key={selectedEdge.id}
                value={selectedEdge.data.raw.label ?? ""}
                onCommit={(label) => patchEdge(selectedEdge.id, { label: label || undefined })}
              />
              <label className="flex shrink-0 items-center gap-1 whitespace-nowrap">
                <Checkbox
                  checked={(selectedEdge.data.raw.toEnd ?? "arrow") === "arrow"}
                  onCheckedChange={(checked) => patchEdge(selectedEdge.id, { toEnd: checked ? "arrow" : "none" })}
                />
                Arrow at end
              </label>
              <label className="flex shrink-0 items-center gap-1 whitespace-nowrap">
                <Checkbox
                  checked={selectedEdge.data.raw.fromEnd === "arrow"}
                  onCheckedChange={(checked) => patchEdge(selectedEdge.id, { fromEnd: checked ? "arrow" : "none" })}
                />
                Arrow at start
              </label>
            </>
          )}
        </div>
      )}

      <CanvasCardPicker
        docId={doc.id}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={(item) => addCard({ kind: item.kind, id: item.id }, item.title)}
      />

      <CanvasTreeDialog docId={doc.id} open={treeOpen} onOpenChange={setTreeOpen} onBuild={handleBuildTree} />

      {treeNotice && (
        <div role="status" data-testid="tree-notice" className="flex items-center justify-between gap-3 border-b border-border-default bg-surface-inset px-4 py-1.5 text-xs text-text-secondary sm:px-8">
          <span>{treeNotice}</span>
          <button type="button" className="shrink-0 text-primary hover:underline" onClick={() => setTreeNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div
        ref={wrapperRef}
        className="relative min-h-[420px] flex-1"
        data-testid="canvas-surface"
        onDragOver={onCanvasDragOver}
        onDrop={onCanvasDrop}
      >
        <CanvasUiContext.Provider value={ui}>
          <ReactFlow
            nodes={nodes as unknown as Node[]}
            edges={edges as unknown as Edge[]}
            nodeTypes={canvasNodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStop={onNodeDragStop}
            onConnect={onConnect}
            onDelete={onDelete}
            connectionMode={ConnectionMode.Loose}
            nodesDraggable={!locked}
            nodesConnectable={!locked}
            elementsSelectable={!locked}
            edgesReconnectable={false}
            // Selecting a group must not lift it over the cards it frames.
            elevateNodesOnSelect={false}
            deleteKeyCode={locked ? null : ["Backspace", "Delete"]}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            minZoom={0.05}
            maxZoom={4}
            onlyRenderVisibleElements
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} />
            <Controls showInteractive={false} position="bottom-right" />
            <MiniMap pannable zoomable className="!hidden md:!block" />
          </ReactFlow>
        </CanvasUiContext.Provider>
      </div>

      <DocVersionHistoryPanel
        restore={async (versionId, content) => {
          if (pendingContent.current !== null || saveQueue.pending()) throw new Error("Save your current changes before restoring.")
          let restoredTitle = title
          await saveQueue.enqueue({
            kind: "restore",
            versionId,
            onDone: (result) => {
              restoredTitle = result.title
              handleRestored(content, result.title)
            },
          })
          return { title: restoredTitle }
        }}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        initialPin={initialHistoryPin}
        currentTitle={title}
        currentContent={currentContent}
        versions={versions}
        revalidatePathStr={revalidatePathStr}
        onRestored={handleRestored}
      />
    </div>
  )
}

function Divider() {
  return <div className="mx-1 h-5 w-px shrink-0 bg-border-default" />
}

function ToolButton({
  label,
  onClick,
  disabled,
  pressed,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  pressed?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-8 shrink-0 items-center justify-center gap-1 rounded px-2 text-xs text-text-secondary transition-colors hover:bg-surface-inset hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40",
        pressed && "bg-primary/10 text-primary"
      )}
    >
      {children}
    </button>
  )
}

const PRESET_NAMES: Record<string, string> = { "1": "Red", "2": "Orange", "3": "Yellow", "4": "Green", "5": "Cyan", "6": "Purple" }

function ColorPicker({ value, onChange }: { value: string | undefined; onChange: (color: string | undefined) => void }) {
  return (
    <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Color">
      <button
        type="button"
        data-testid="color-none"
        aria-label="No color"
        aria-pressed={value === undefined}
        onClick={() => onChange(undefined)}
        className={cn("size-5 rounded-full border border-border-default bg-surface-card", value === undefined && "ring-2 ring-primary")}
      />
      {Object.entries(CANVAS_PRESET_COLORS).map(([key, hex]) => (
        <button
          key={key}
          type="button"
          data-testid={`color-${key}`}
          aria-label={`${PRESET_NAMES[key]} (${key})`}
          aria-pressed={value === key}
          onClick={() => onChange(key)}
          className={cn("size-5 rounded-full border border-black/10", value === key && "ring-2 ring-primary ring-offset-1")}
          style={{ backgroundColor: hex }}
        />
      ))}
      <input
        type="color"
        aria-label="Custom color"
        data-testid="color-custom"
        value={value && isValidCanvasColor(value) && value.startsWith("#") && value.length === 7 ? value : "#888888"}
        onChange={(e) => onChange(e.target.value)}
        className="size-5 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
      />
    </div>
  )
}

function EdgeLabelInput({ value, onCommit }: { value: string; onCommit: (label: string) => void }) {
  const [draft, setDraft] = useState(value)
  return (
    <input
      type="text"
      aria-label="Edge label"
      placeholder="Edge label"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur()
      }}
      className="w-36 shrink-0 rounded border border-border-default bg-surface-card px-2 py-1 outline-none focus:ring-1 focus:ring-border-focus"
    />
  )
}
