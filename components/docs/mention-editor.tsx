"use client"

/**
 * A small contenteditable composer where typing "@" opens one grouped picker of
 * people and agents. A selected mention becomes a non-editable chip; the editor
 * reports its content as a plain string in which each chip is the id-bearing
 * token from lib/comment-mentions.ts, so what is stored never depends on a name.
 *
 * Keyboard: ArrowUp/ArrowDown move, Enter or Tab select, Escape dismisses the
 * picker and leaves the literal "@" in place. With the picker closed, Enter
 * inserts a line break and Cmd/Ctrl+Enter calls onSubmitShortcut.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import { bodySegments, serializeMention, type MentionKind } from "@/lib/comment-mentions"

export interface MentionOption {
  kind: MentionKind
  id: string
  name: string
  /** Email for people, description for agents. */
  detail: string | null
  /** An org member with no access to this workspace. */
  outsideWorkspace?: boolean
  /** Agents only: access level of the active grant in this workspace. */
  access?: "READ" | "WRITE"
}

export interface MentionOptions {
  people: MentionOption[]
  agents: MentionOption[]
  outside: MentionOption[]
}

interface MentionEditorProps {
  options: MentionOptions
  /** Serialized body to load once on mount (editing an existing comment); mention tokens become chips. */
  initialValue?: string
  ariaLabel: string
  placeholder: string
  onChange: (body: string) => void
  onSubmitShortcut?: () => void
  /** Escape with the picker closed (lets the host cancel the composer). */
  onEscape?: () => void
  autoFocus?: boolean
  disabled?: boolean
  className?: string
  testId?: string
}

const TRIGGER = /(^|[\s(])@([^\s@][^@\n]{0,29})?$/
const MAX_PER_GROUP = 8

/** Serialize the editor DOM: text as-is, <br> as a newline, each chip as its token. */
export function serializeEditor(root: Node): string {
  let out = ""
  root.childNodes.forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += (node.textContent ?? "").replace(/​/g, "")
      return
    }
    if (!(node instanceof HTMLElement)) return
    if (node.dataset.mentionId && node.dataset.mentionKind) {
      out += serializeMention({
        kind: node.dataset.mentionKind as MentionKind,
        id: node.dataset.mentionId,
        label: node.dataset.mentionLabel ?? "",
      })
    } else if (node.tagName === "BR") {
      out += "\n"
    } else {
      // A block the browser wrapped a line in.
      const inner = serializeEditor(node)
      out += (out && !out.endsWith("\n") ? "\n" : "") + inner
    }
  })
  return out
}

function createChip(kind: MentionKind, id: string, name: string, outsideWorkspace?: boolean): HTMLSpanElement {
  const chip = document.createElement("span")
  chip.contentEditable = "false"
  chip.dataset.mentionKind = kind
  chip.dataset.mentionId = id
  chip.dataset.mentionLabel = name
  chip.dataset.testid = "mention-chip"
  chip.className = cn("mention-chip", kind === "agent" && "mention-chip-agent", outsideWorkspace && "mention-chip-outside")
  chip.textContent = `@${name}`
  return chip
}

/** Fill the editor from a serialized body: text and line breaks as-is, each mention token as a chip with its live name. */
function loadBody(root: HTMLElement, body: string, options: MentionOptions) {
  const live = new Map<string, MentionOption>()
  for (const option of [...options.people, ...options.agents, ...options.outside]) live.set(`${option.kind}:${option.id}`, option)
  root.textContent = ""
  for (const segment of bodySegments(body)) {
    if (segment.type === "mention") {
      const { kind, id, label } = segment.mention
      const option = live.get(`${kind}:${id}`)
      root.append(createChip(kind, id, option?.name ?? label, option?.outsideWorkspace))
      continue
    }
    segment.text.split("\n").forEach((line, index) => {
      if (index > 0) root.append(document.createElement("br"))
      if (line) root.append(document.createTextNode(line))
    })
  }
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase()
}

function matches(option: MentionOption, query: string): number {
  if (!query) return 1
  const q = query.toLowerCase()
  const name = option.name.toLowerCase()
  if (name.startsWith(q) || name.split(/\s+/).some(part => part.startsWith(q))) return 2
  return name.includes(q) || (option.detail?.toLowerCase().includes(q) ?? false) ? 1 : 0
}

function filterGroup(group: MentionOption[], query: string): MentionOption[] {
  return group
    .map(option => ({ option, score: matches(option, query) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.option.name.localeCompare(b.option.name))
    .slice(0, MAX_PER_GROUP)
    .map(entry => entry.option)
}

function groupsFor(options: MentionOptions, query: string) {
  return [
    { id: "people", title: "People", items: filterGroup(options.people, query) },
    { id: "agents", title: "Agents", items: filterGroup(options.agents, query) },
    { id: "outside", title: "Not in this workspace", items: filterGroup(options.outside, query) },
  ].filter(group => group.items.length > 0)
}

function HighlightedName({ name, query }: { name: string; query: string }): ReactNode {
  const index = query ? name.toLowerCase().indexOf(query.toLowerCase()) : -1
  if (index < 0) return name
  return (
    <>
      {name.slice(0, index)}
      <b className="text-status-info">{name.slice(index, index + query.length)}</b>
      {name.slice(index + query.length)}
    </>
  )
}

export function MentionEditor({
  options, initialValue, ariaLabel, placeholder, onChange, onSubmitShortcut, onEscape, autoFocus, disabled, className, testId,
}: MentionEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const pickerRef = useRef<HTMLDivElement>(null)
  // The text node and offsets of the "@query" being typed.
  const triggerRef = useRef<{ node: Text; start: number; end: number } | null>(null)
  const [query, setQuery] = useState<string | null>(null)
  const [active, setActive] = useState(0)

  // What the keyboard handlers act on, updated synchronously with the DOM. State is one render behind a fast typist
  // ("@Adv Agent" then Enter in the same tick), so reading it in onKeyDown could miss an open picker and insert a
  // line break instead of selecting.
  const liveRef = useRef<{ flat: MentionOption[]; active: number } | null>(null)

  const groups = useMemo(() => {
    if (query === null) return []
    return groupsFor(options, query)
  }, [options, query])
  const flat = useMemo(() => groups.flatMap(group => group.items), [groups])
  const open = query !== null && flat.length > 0

  const close = useCallback(() => {
    triggerRef.current = null
    liveRef.current = null
    setQuery(null)
    setActive(0)
  }, [])

  const emit = useCallback(() => {
    const root = editorRef.current
    if (!root) return
    const body = serializeEditor(root)
    // A browser leaves a stray <br> behind after deleting everything; clear it so :empty placeholder returns.
    if (body === "" && root.childNodes.length > 0) root.innerHTML = ""
    onChange(body)
  }, [onChange])

  const detectTrigger = useCallback(() => {
    const root = editorRef.current
    const selection = window.getSelection()
    if (!root || !selection || selection.rangeCount === 0 || !selection.isCollapsed) return close()
    const { anchorNode, anchorOffset } = selection
    if (!anchorNode || anchorNode.nodeType !== Node.TEXT_NODE || !root.contains(anchorNode)) return close()
    const before = (anchorNode.textContent ?? "").slice(0, anchorOffset)
    const match = TRIGGER.exec(before)
    if (!match) return close()
    const start = match.index + match[1].length
    triggerRef.current = { node: anchorNode as Text, start, end: anchorOffset }
    const q = match[2] ?? ""
    const flatNow = groupsFor(options, q).flatMap(group => group.items)
    liveRef.current = flatNow.length > 0 ? { flat: flatNow, active: 0 } : null
    setQuery(q)
    setActive(0)
  }, [close, options])

  const select = useCallback((option: MentionOption) => {
    const root = editorRef.current
    const trigger = triggerRef.current
    if (!root || !trigger) return
    const range = document.createRange()
    range.setStart(trigger.node, trigger.start)
    range.setEnd(trigger.node, trigger.end)
    range.deleteContents()

    const chip = createChip(option.kind, option.id, option.name, option.outsideWorkspace)
    range.insertNode(chip)

    const space = document.createTextNode(" ")
    chip.after(space)
    const caret = document.createRange()
    caret.setStart(space, 1)
    caret.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(caret)

    close()
    emit()
  }, [close, emit])

  // Mount only: the editor is uncontrolled afterwards (a later initialValue or options change must never rewrite what
  // the user is typing), so the first value is captured and chips use the options known at that moment.
  const mountValue = useRef({ initialValue, options })
  useLayoutEffect(() => {
    const { initialValue: body, options: known } = mountValue.current
    if (body && editorRef.current) loadBody(editorRef.current, body, known)
  }, [])

  useEffect(() => {
    if (!autoFocus) return
    const root = editorRef.current
    root?.focus()
    // Editing: put the caret after the existing text.
    if (root && mountValue.current.initialValue) {
      const end = document.createRange()
      end.selectNodeContents(root)
      end.collapse(false)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(end)
    }
  }, [autoFocus])

  // The picker sits in the flow below the editor (never overlaid), so no ancestor can clip it: it grows the
  // popover or the thread list instead. Bring it into view when it opens, and keep the active row visible.
  useEffect(() => {
    if (open) pickerRef.current?.scrollIntoView?.({ block: "nearest" })
  }, [open])
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" })
  }, [open, active, listId])

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const live = liveRef.current
    if (live) {
      const move = (delta: number) => {
        live.active = (live.active + delta + live.flat.length) % live.flat.length
        setActive(live.active)
      }
      if (event.key === "ArrowDown") { event.preventDefault(); move(1); return }
      if (event.key === "ArrowUp") { event.preventDefault(); move(-1); return }
      if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); select(live.flat[live.active]); return }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return }
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      onSubmitShortcut?.()
      return
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      document.execCommand("insertLineBreak")
      emit()
      return
    }
    if (event.key === "Escape") onEscape?.()
  }

  function onPaste(event: React.ClipboardEvent<HTMLDivElement>) {
    event.preventDefault()
    const text = event.clipboardData.getData("text/plain")
    const root = editorRef.current
    if (!root || !text) return
    // Keep the caret inside the editor; with none there, paste at the end.
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || !root.contains(selection.getRangeAt(0).commonAncestorContainer)) {
      const atEnd = document.createRange()
      atEnd.selectNodeContents(root)
      atEnd.collapse(false)
      selection?.removeAllRanges()
      selection?.addRange(atEnd)
    }
    // Prefer execCommand("insertText"): it is the only insertion that joins the browser's native undo stack, so
    // Ctrl+Z takes a paste back. It inserts plain text only, so no pasted markup gets in. Where the browser
    // declines it (nothing changed), fall back to inserting through the Range API, which always works.
    const before = root.textContent
    let inserted = false
    try {
      inserted = typeof document.execCommand === "function" && document.execCommand("insertText", false, text) && root.textContent !== before
    } catch {
      inserted = false
    }
    if (!inserted && selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0)
      range.deleteContents()
      const node = document.createTextNode(text)
      range.insertNode(node)
      const caret = document.createRange()
      caret.setStartAfter(node)
      caret.collapse(true)
      selection.removeAllRanges()
      selection.addRange(caret)
    }
    close()
    emit()
  }

  // Each option's position in the flat keyboard order, without mutating anything during render.
  const startOf = new Map<string, number>()
  groups.reduce((offset, group) => { startOf.set(group.id, offset); return offset + group.items.length }, 0)
  return (
    <div className="relative">
      <div
        ref={editorRef}
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        aria-autocomplete="list"
        data-placeholder={placeholder}
        data-testid={testId}
        contentEditable={!disabled}
        suppressContentEditableWarning
        spellCheck
        onInput={() => { emit(); detectTrigger() }}
        onKeyDown={onKeyDown}
        onKeyUp={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) detectTrigger() }}
        onClick={detectTrigger}
        onBlur={() => window.setTimeout(close, 120)}
        onPaste={onPaste}
        className={cn(
          "min-h-11 w-full whitespace-pre-wrap break-words rounded-lg border border-border-default bg-surface-panel px-2 py-1.5 text-sm text-text-primary outline-none focus-visible:ring-1 focus-visible:ring-border-focus",
          "empty:before:pointer-events-none empty:before:text-text-subtle empty:before:content-[attr(data-placeholder)]",
          disabled && "opacity-60",
          className,
        )}
      />
      {open && (
        <div
          ref={pickerRef}
          data-testid="mention-picker"
          className="mt-1 flex flex-col rounded-lg border border-border-default bg-surface-card p-1.5 shadow-md"
          // Keep focus (and the caret) in the editor while the pointer picks an option.
          onMouseDown={event => event.preventDefault()}
        >
          <div
            id={listId}
            role="listbox"
            aria-label="Mention suggestions"
            className="max-h-[min(16rem,40vh)] min-h-0 overflow-y-auto overscroll-contain"
          >
          {groups.map(group => (
            <div key={group.id}>
              <div className="px-2 pb-0.5 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-text-subtle">{group.title}</div>
              {group.items.map((option, itemIndex) => {
                const index = (startOf.get(group.id) ?? 0) + itemIndex
                const agent = option.kind === "agent"
                return (
                  <div
                    key={`${option.kind}:${option.id}`}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === active}
                    data-testid="mention-option"
                    data-mention-name={option.name}
                    onMouseEnter={() => { if (liveRef.current) liveRef.current.active = index; setActive(index) }}
                    onClick={() => select(option)}
                    className={cn("flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5", index === active && "bg-status-info-surface")}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold",
                        agent ? "bg-agent-accent text-text-inverse" : option.outsideWorkspace ? "bg-status-warning text-text-inverse" : "bg-status-neutral text-text-inverse",
                      )}
                    >
                      {agent ? "⚙" : initials(option.name)}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col leading-tight">
                      <span className="truncate text-sm text-text-primary"><HighlightedName name={option.name} query={query ?? ""} /></span>
                      {option.detail && <span className="truncate text-xs text-text-subtle">{option.detail}</span>}
                    </span>
                    {agent && <span className="rounded bg-agent-accent-surface px-1.5 py-px text-[10px] font-semibold text-agent-accent">Agent</span>}
                    {index === active && <span aria-hidden className="text-xs text-text-subtle">{"↵"}</span>}
                  </div>
                )
              })}
            </div>
          ))}
          </div>
          <div className="mt-1.5 flex gap-3 border-t border-border-default px-2 pb-0.5 pt-1.5 text-[11px] text-text-subtle">
            <span><kbd className="rounded border border-border-default px-1">{"↑"}</kbd> <kbd className="rounded border border-border-default px-1">{"↓"}</kbd> navigate</span>
            <span><kbd className="rounded border border-border-default px-1">{"↵"}</kbd> select</span>
            <span><kbd className="rounded border border-border-default px-1">esc</kbd> dismiss</span>
          </div>
        </div>
      )}
    </div>
  )
}
