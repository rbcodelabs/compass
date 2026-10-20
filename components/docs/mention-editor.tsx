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
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import { serializeMention, type MentionKind } from "@/lib/comment-mentions"

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
  ariaLabel: string
  placeholder: string
  onChange: (body: string) => void
  onSubmitShortcut?: () => void
  /** Escape with the picker closed (lets the host cancel the composer). */
  onEscape?: () => void
  autoFocus?: boolean
  disabled?: boolean
  /** Open the picker above the editor; for composers at the bottom of a scroll area. */
  popupAbove?: boolean
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
  options, ariaLabel, placeholder, onChange, onSubmitShortcut, onEscape, autoFocus, disabled, popupAbove, className, testId,
}: MentionEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  // The text node and offsets of the "@query" being typed.
  const triggerRef = useRef<{ node: Text; start: number; end: number } | null>(null)
  const [query, setQuery] = useState<string | null>(null)
  const [active, setActive] = useState(0)

  const groups = useMemo(() => {
    if (query === null) return []
    return [
      { id: "people", title: "People", items: filterGroup(options.people, query) },
      { id: "agents", title: "Agents", items: filterGroup(options.agents, query) },
      { id: "outside", title: "Not in this workspace", items: filterGroup(options.outside, query) },
    ].filter(group => group.items.length > 0)
  }, [options, query])
  const flat = useMemo(() => groups.flatMap(group => group.items), [groups])
  const open = query !== null && flat.length > 0

  const close = useCallback(() => {
    triggerRef.current = null
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
    setQuery(match[2] ?? "")
    setActive(0)
  }, [close])

  const select = useCallback((option: MentionOption) => {
    const root = editorRef.current
    const trigger = triggerRef.current
    if (!root || !trigger) return
    const range = document.createRange()
    range.setStart(trigger.node, trigger.start)
    range.setEnd(trigger.node, trigger.end)
    range.deleteContents()

    const chip = document.createElement("span")
    chip.contentEditable = "false"
    chip.dataset.mentionKind = option.kind
    chip.dataset.mentionId = option.id
    chip.dataset.mentionLabel = option.name
    chip.dataset.testid = "mention-chip"
    chip.className = cn("mention-chip", option.kind === "agent" && "mention-chip-agent", option.outsideWorkspace && "mention-chip-outside")
    chip.textContent = `@${option.name}`
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

  useEffect(() => {
    if (autoFocus) editorRef.current?.focus()
  }, [autoFocus])

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (open) {
      if (event.key === "ArrowDown") { event.preventDefault(); setActive(i => (i + 1) % flat.length); return }
      if (event.key === "ArrowUp") { event.preventDefault(); setActive(i => (i - 1 + flat.length) % flat.length); return }
      if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); select(flat[active]); return }
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
    document.execCommand("insertText", false, event.clipboardData.getData("text/plain"))
  }

  let flatIndex = -1
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
          id={listId}
          role="listbox"
          aria-label="Mention suggestions"
          data-testid="mention-picker"
          className={cn(
            "absolute inset-x-0 z-30 rounded-lg border border-border-default bg-surface-card p-1.5 shadow-md",
            popupAbove ? "bottom-full mb-1" : "top-full mt-1",
          )}
          // Keep focus (and the caret) in the editor while the pointer picks an option.
          onMouseDown={event => event.preventDefault()}
        >
          {groups.map(group => (
            <div key={group.id}>
              <div className="px-2 pb-0.5 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-text-subtle">{group.title}</div>
              {group.items.map(option => {
                flatIndex += 1
                const index = flatIndex
                const agent = option.kind === "agent"
                return (
                  <div
                    key={`${option.kind}:${option.id}`}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === active}
                    data-testid="mention-option"
                    data-mention-name={option.name}
                    onMouseEnter={() => setActive(index)}
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
