"use client"

/**
 * React Flow node renderers for the JSON Canvas doc editor: text (markdown),
 * file (labeled card), link (URL card) and group (labeled frame).
 *
 * Nodes are presentational. All edits go through CanvasUiContext so the editor
 * owns history and autosave; `data.raw` is the source JSON Canvas node.
 *
 * File nodes: JSON Canvas `file` points at a path in an Obsidian-style vault,
 * which has no meaning inside Compass. They render as labeled cards (basename,
 * folder, optional #subpath) and are editable as plain text; they are not
 * resolved against Compass docs. See docs/content/06-docs.md.
 */
import { createContext, memo, useContext, useEffect, useRef, useState } from "react"
import { Handle, NodeResizer, Position, type Node, type NodeProps } from "@xyflow/react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { ExternalLink, FileText, Link2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { resolveCanvasColor, type JsonCanvasNode } from "@/lib/json-canvas"

export type CanvasRFNode = Node<{ raw: JsonCanvasNode }>

export type CanvasUi = {
  readOnly: boolean
  editingId: string | null
  setEditingId: (id: string | null) => void
  /** Merge a change into a node's JSON Canvas fields (commits history + autosave). */
  patchNode: (id: string, patch: Partial<JsonCanvasNode>) => void
  /** Called after a resize gesture finishes so geometry can be committed. */
  onResizeEnd: () => void
}

export const CanvasUiContext = createContext<CanvasUi>({
  readOnly: true,
  editingId: null,
  setEditingId: () => {},
  patchNode: () => {},
  onResizeEnd: () => {},
})

const SIDES = [
  [Position.Top, "top"],
  [Position.Right, "right"],
  [Position.Bottom, "bottom"],
  [Position.Left, "left"],
] as const

function SideHandles({ selected, readOnly }: { selected: boolean; readOnly: boolean }) {
  return (
    <>
      {SIDES.map(([position, id]) => (
        <Handle
          key={id}
          id={id}
          type="source"
          position={position}
          isConnectable={!readOnly}
          data-testid={`handle-${id}`}
          className={cn(
            "!size-3.5 !border-2 !border-surface-card !bg-primary transition-opacity",
            selected && !readOnly ? "!opacity-100" : "!opacity-0 group-hover/node:!opacity-100"
          )}
        />
      ))}
    </>
  )
}

function Shell({
  id,
  selected,
  raw,
  className,
  children,
}: {
  id: string
  selected: boolean
  raw: JsonCanvasNode
  className?: string
  children: React.ReactNode
}) {
  const ui = useContext(CanvasUiContext)
  const color = resolveCanvasColor(raw.color)
  return (
    <div
      data-testid={`canvas-node-${raw.type}`}
      data-node-id={id}
      className={cn(
        "group/node relative h-full w-full rounded-lg border-2 bg-surface-card text-text-primary shadow-sm",
        selected ? "ring-2 ring-primary/50" : "",
        !color && "border-border-default",
        className
      )}
      style={color ? { borderColor: color, backgroundColor: `color-mix(in srgb, ${color} 14%, var(--surface-card, white))` } : undefined}
    >
      <NodeResizer
        isVisible={selected && !ui.readOnly}
        minWidth={80}
        minHeight={40}
        onResizeEnd={ui.onResizeEnd}
        handleClassName="!size-2.5 !rounded-sm"
      />
      {children}
      <SideHandles selected={selected} readOnly={ui.readOnly} />
    </div>
  )
}

/** Inline textarea used while editing; commits on blur, cancels on Escape. */
function InlineEditor({
  value,
  multiline,
  placeholder,
  onCommit,
  onCancel,
  label,
}: {
  value: string
  multiline?: boolean
  placeholder?: string
  onCommit: (value: string) => void
  onCancel: () => void
  label: string
}) {
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null)
  const cancelled = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const shared = {
    ref,
    value: draft,
    placeholder,
    "aria-label": label,
    // nodrag/nowheel/nopan keep React Flow from hijacking text selection and scrolling.
    className: "nodrag nowheel nopan h-full w-full resize-none bg-transparent p-2 text-sm outline-none",
    onChange: (event: React.ChangeEvent<HTMLTextAreaElement & HTMLInputElement>) => setDraft(event.target.value),
    onBlur: () => (cancelled.current ? onCancel() : onCommit(draft)),
    onKeyDown: (event: React.KeyboardEvent) => {
      event.stopPropagation()
      if (event.key === "Escape") {
        cancelled.current = true
        ;(event.target as HTMLElement).blur()
      }
      if (event.key === "Enter" && (!multiline || event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        ;(event.target as HTMLElement).blur()
      }
    },
  }
  return multiline ? <textarea {...shared} /> : <input type="text" {...shared} />
}

function TextNodeComponent({ id, data, selected }: NodeProps<CanvasRFNode>) {
  const ui = useContext(CanvasUiContext)
  const raw = data.raw
  const editing = ui.editingId === id && !ui.readOnly
  return (
    <Shell id={id} selected={selected} raw={raw}>
      {editing ? (
        <InlineEditor
          multiline
          label="Edit text (markdown)"
          value={raw.text ?? ""}
          placeholder="Write markdown…"
          onCommit={(text) => {
            ui.setEditingId(null)
            if (text !== (raw.text ?? "")) ui.patchNode(id, { text })
          }}
          onCancel={() => ui.setEditingId(null)}
        />
      ) : (
        <div
          className="nowheel h-full overflow-auto p-2 text-sm [&_a]:text-primary [&_a]:underline [&_h1]:text-base [&_h1]:font-semibold [&_h2]:font-semibold [&_li]:ml-4 [&_ol]:list-decimal [&_p]:my-1 [&_ul]:list-disc [&_code]:rounded [&_code]:bg-surface-inset [&_code]:px-1"
          data-testid="canvas-text-content"
          onDoubleClick={() => !ui.readOnly && ui.setEditingId(id)}
        >
          {raw.text ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{raw.text}</ReactMarkdown>
          ) : (
            <span className="text-text-disabled">Double-click to edit</span>
          )}
        </div>
      )}
    </Shell>
  )
}

function FileNodeComponent({ id, data, selected }: NodeProps<CanvasRFNode>) {
  const ui = useContext(CanvasUiContext)
  const raw = data.raw
  const editing = ui.editingId === id && !ui.readOnly
  const path = raw.file ?? ""
  const slash = path.lastIndexOf("/")
  const dir = slash >= 0 ? path.slice(0, slash) : ""
  const name = slash >= 0 ? path.slice(slash + 1) : path
  return (
    <Shell id={id} selected={selected} raw={raw}>
      {editing ? (
        <InlineEditor
          label="Edit file path"
          value={path}
          onCommit={(file) => {
            ui.setEditingId(null)
            if (file.trim() && file !== path) ui.patchNode(id, { file: file.trim() })
          }}
          onCancel={() => ui.setEditingId(null)}
        />
      ) : (
        <div
          className="flex h-full items-center gap-2 p-2"
          onDoubleClick={() => !ui.readOnly && ui.setEditingId(id)}
        >
          <FileText className="size-5 shrink-0 text-text-subtle" aria-hidden />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium" title={path}>{name}</div>
            {(dir || raw.subpath) && (
              <div className="truncate text-xs text-text-subtle">{[dir, raw.subpath].filter(Boolean).join(" ")}</div>
            )}
          </div>
        </div>
      )}
    </Shell>
  )
}

function LinkNodeComponent({ id, data, selected }: NodeProps<CanvasRFNode>) {
  const ui = useContext(CanvasUiContext)
  const raw = data.raw
  const editing = ui.editingId === id && !ui.readOnly
  const url = raw.url ?? ""
  // Only ever render http(s) as a real anchor; anything else (javascript:, data:) stays inert text.
  const safe = /^https?:\/\//i.test(url)
  let host = url
  try {
    host = new URL(url).host || url
  } catch {
    /* keep raw string */
  }
  return (
    <Shell id={id} selected={selected} raw={raw}>
      {editing ? (
        <InlineEditor
          label="Edit link URL"
          value={url}
          onCommit={(next) => {
            ui.setEditingId(null)
            if (next !== url) ui.patchNode(id, { url: next.trim() })
          }}
          onCancel={() => ui.setEditingId(null)}
        />
      ) : (
        <div className="flex h-full items-center gap-2 p-2" onDoubleClick={() => !ui.readOnly && ui.setEditingId(id)}>
          <Link2 className="size-5 shrink-0 text-text-subtle" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{host}</div>
            <div className="truncate text-xs text-text-subtle" title={url}>{url}</div>
          </div>
          {safe && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open link in new tab"
              className="nodrag shrink-0 rounded p-1 text-text-subtle hover:bg-surface-inset hover:text-text-primary"
            >
              <ExternalLink className="size-4" />
            </a>
          )}
        </div>
      )}
    </Shell>
  )
}

function GroupNodeComponent({ id, data, selected }: NodeProps<CanvasRFNode>) {
  const ui = useContext(CanvasUiContext)
  const raw = data.raw
  const editing = ui.editingId === id && !ui.readOnly
  return (
    <Shell id={id} selected={selected} raw={raw} className="border-dashed bg-surface-inset/40">
      <div className="h-8 px-2 py-1" onDoubleClick={() => !ui.readOnly && ui.setEditingId(id)}>
        {editing ? (
          <InlineEditor
            label="Edit group label"
            value={raw.label ?? ""}
            onCommit={(label) => {
              ui.setEditingId(null)
              if (label !== (raw.label ?? "")) ui.patchNode(id, { label })
            }}
            onCancel={() => ui.setEditingId(null)}
          />
        ) : (
          <span className="truncate text-sm font-semibold text-text-secondary">{raw.label || "Group"}</span>
        )}
      </div>
    </Shell>
  )
}

export const canvasNodeTypes = {
  text: memo(TextNodeComponent),
  file: memo(FileNodeComponent),
  link: memo(LinkNodeComponent),
  group: memo(GroupNodeComponent),
}
