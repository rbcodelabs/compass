"use client"

// The agent chat composer: one rounded card holding an optional top strip (run status and context chips), the
// auto-growing message field with its send/stop button, and a footer tray for the Agent and Model chips.
// It is presentational: AgentChat owns the state and the semantics (what is disabled, what stop does).

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react"
import { ArrowUp, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { MentionOption, MentionOptions } from "@/components/docs/mention-editor"
import { cn } from "@/lib/utils"

const MAX_HEIGHT_PX = 150
/** A send from this composer moves focus to Stop only if the run starts within this window; later runs are not ours to react to. */
const SEND_INTENT_MS = 10_000
const MENTION_TRIGGER = /(^|[\s(])@([^\s@][^@\n]{0,29})?$/
const MAX_PER_GROUP = 8

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1]![0] : "")).toUpperCase()
}

function matchesOption(option: MentionOption, query: string): number {
  if (!query) return 1
  const q = query.toLowerCase()
  const name = option.name.toLowerCase()
  if (name.startsWith(q) || name.split(/\s+/).some((part) => part.startsWith(q))) return 2
  return name.includes(q) || (option.detail?.toLowerCase().includes(q) ?? false) ? 1 : 0
}

function filterGroup(group: MentionOption[], query: string): MentionOption[] {
  return group
    .map((option) => ({ option, score: matchesOption(option, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.option.name.localeCompare(b.option.name))
    .slice(0, MAX_PER_GROUP)
    .map((entry) => entry.option)
}

function groupsFor(options: MentionOptions, query: string) {
  return [
    { id: "people", title: "People", items: filterGroup(options.people, query) },
    { id: "agents", title: "Agents", items: filterGroup(options.agents, query) },
    { id: "outside", title: "Not in this workspace", items: filterGroup(options.outside, query) },
  ].filter((group) => group.items.length > 0)
}

type Props = {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  value: string
  onChange: (value: string) => void
  /** Enter (without Shift) and the send button both call this; it is only called when sending is allowed. */
  onSend: () => void
  placeholder?: string
  textareaDisabled: boolean
  sendDisabled: boolean
  /** A run is in flight: the stop button takes the send button's slot and Escape stops it. */
  running: boolean
  onStop: () => void
  stopDisabled?: boolean
  stopTitle?: string
  /** Run status line shown in the top strip (spinner + text). */
  status?: ReactNode
  /** Context chips (seed entity, doc) shown in the top strip. */
  contextChips?: ReactNode
  /** The Agent and Model chips. The footer is omitted when there are none. */
  chips?: ReactNode
  /** Called with the pasted text before it lands in the field; return true to consume the paste (it became a chip). */
  onPasteText?: (text: string) => boolean
  /** Greys the card like a read-only surface (access lost). */
  readOnly?: boolean
  /** False when someone else started the run being watched: their run never moves this user's focus. Default true. */
  runStartedByMe?: boolean
  /** Optional workspace people + agents for `@` mention autocomplete. */
  mentionOptions?: MentionOptions
}

export function ComposerCard(props: Props) {
  const { textareaRef, value, onChange, onSend, placeholder = "Message the agent…", textareaDisabled, sendDisabled, running, onStop, stopDisabled, stopTitle, status, contextChips, chips, readOnly, onPasteText, runStartedByMe = true, mentionOptions } = props
  const hintId = useId()
  const listId = useId()
  const stopRef = useRef<HTMLButtonElement>(null)
  const wasRunning = useRef(running)
  // Focus intent is recorded from events, not read back from the DOM: sending disables the field and Stop unmounts when the
  // run ends, and browsers disagree on whether (and in what order) blur fires for an element that is disabled or removed.
  const sentAt = useRef(0)
  const returnFocus = useRef(false)
  const triggerRangeRef = useRef<{ start: number; end: number } | null>(null)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [activeMentionIdx, setActiveMentionIdx] = useState(0)

  const groups = useMemo(() => {
    if (mentionQuery === null || !mentionOptions) return []
    return groupsFor(mentionOptions, mentionQuery)
  }, [mentionOptions, mentionQuery])
  const flatMentions = useMemo(() => groups.flatMap((g) => g.items), [groups])
  const mentionOpen = mentionQuery !== null && flatMentions.length > 0

  const closeMentions = useCallback(() => {
    triggerRangeRef.current = null
    setMentionQuery(null)
    setActiveMentionIdx(0)
  }, [])

  const detectMention = useCallback(
    (text: string, caret: number | null) => {
      if (!mentionOptions || caret === null) {
        closeMentions()
        return
      }
      const before = text.slice(0, caret)
      const match = MENTION_TRIGGER.exec(before)
      if (!match) {
        closeMentions()
        return
      }
      const start = match.index + match[1]!.length
      triggerRangeRef.current = { start, end: caret }
      setMentionQuery(match[2] ?? "")
      setActiveMentionIdx(0)
    },
    [mentionOptions, closeMentions],
  )

  const selectMention = useCallback(
    (option: MentionOption) => {
      const range = triggerRangeRef.current
      if (!range) return
      const insertion = `@${option.name} `
      const next = value.slice(0, range.start) + insertion + value.slice(range.end)
      const nextCaret = range.start + insertion.length
      closeMentions()
      onChange(next)
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(nextCaret, nextCaret)
      })
    },
    [value, onChange, closeMentions, textareaRef],
  )

  const send = () => {
    closeMentions()
    sentAt.current = Date.now()
    onSend()
  }

  // Grow with the content up to MAX_HEIGHT_PX, then scroll. Done in script (not field-sizing) so every browser agrees.
  const grow = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`
  }
  useLayoutEffect(grow, [value, textareaRef]) // eslint-disable-line react-hooks/exhaustive-deps -- grow only reads the ref
  // A width change (rotation, rail resize) re-wraps the text, so the height must be recomputed without a value change.
  useEffect(() => {
    const el = textareaRef.current
    if (!el || typeof ResizeObserver === "undefined") return
    let lastWidth = el.clientWidth
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth) return // our own height writes also land here; only width matters
      lastWidth = el.clientWidth
      grow()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [textareaRef]) // eslint-disable-line react-hooks/exhaustive-deps

  // A run that starts right after this user sent from the composer moves focus to Stop (the field was just disabled, and
  // Escape must keep working). Never for someone else's run, a reattached run, or when the user was not in the composer.
  // When the run ends the field gets focus back once it is enabled again, which may be a render after `running` flips.
  useEffect(() => {
    if (running && !wasRunning.current && runStartedByMe && Date.now() - sentAt.current < SEND_INTENT_MS) {
      sentAt.current = 0
      stopRef.current?.focus()
    }
    wasRunning.current = running
  }, [running, runStartedByMe])
  useEffect(() => {
    if (running || textareaDisabled || !returnFocus.current) return
    returnFocus.current = false
    textareaRef.current?.focus()
  }, [running, textareaDisabled, textareaRef])

  const hasStrip = Boolean(status) || Boolean(contextChips)
  const startOf = new Map<string, number>()
  groups.reduce((offset, group) => {
    startOf.set(group.id, offset)
    return offset + group.items.length
  }, 0)

  return (
    <div className="@container/composer relative mx-auto w-full max-w-3xl min-w-0">
      {mentionOpen && (
        <div
          data-testid="mention-picker"
          className="absolute right-0 bottom-full left-0 z-50 mb-1.5 flex flex-col rounded-lg border border-border-default bg-surface-card p-1.5 shadow-md"
          onMouseDown={(event) => event.preventDefault()}
        >
          <div
            id={listId}
            role="listbox"
            aria-label="Mention suggestions"
            className="max-h-[min(16rem,40vh)] min-h-0 overflow-y-auto overscroll-contain"
          >
            {groups.map((group) => (
              <div key={group.id}>
                <div className="px-2 pt-1.5 pb-0.5 text-[11px] font-medium tracking-wide text-text-subtle uppercase">
                  {group.title}
                </div>
                {group.items.map((option, itemIndex) => {
                  const index = (startOf.get(group.id) ?? 0) + itemIndex
                  const isAgent = option.kind === "agent"
                  const selected = index === Math.min(activeMentionIdx, flatMentions.length - 1)
                  return (
                    <div
                      key={`${option.kind}:${option.id}`}
                      id={`${listId}-${index}`}
                      role="option"
                      aria-selected={selected}
                      data-testid="mention-option"
                      data-mention-name={option.name}
                      onMouseEnter={() => setActiveMentionIdx(index)}
                      onClick={() => selectMention(option)}
                      className={cn(
                        "flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5",
                        selected && "bg-status-info-surface",
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold",
                          isAgent
                            ? "bg-agent-accent text-text-inverse"
                            : option.outsideWorkspace
                              ? "bg-status-warning text-text-inverse"
                              : "bg-status-neutral text-text-inverse",
                        )}
                      >
                        {isAgent ? "⚙" : initials(option.name)}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col leading-tight">
                        <span className="truncate text-sm text-text-primary">{option.name}</span>
                        {option.detail && (
                          <span className="truncate text-xs text-text-subtle">{option.detail}</span>
                        )}
                      </span>
                      {isAgent && (
                        <span className="rounded bg-agent-accent-surface px-1.5 py-px text-[10px] font-semibold text-agent-accent">
                          Agent
                        </span>
                      )}
                      {selected && (
                        <span aria-hidden className="text-xs text-text-subtle">
                          {"↵"}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex gap-3 border-t border-border-default px-2 pt-1.5 pb-0.5 text-[11px] text-text-subtle">
            <span>
              <kbd className="rounded border border-border-default px-1">{"↑"}</kbd>{" "}
              <kbd className="rounded border border-border-default px-1">{"↓"}</kbd> navigate
            </span>
            <span>
              <kbd className="rounded border border-border-default px-1">{"↵"}</kbd> select
            </span>
            <span>
              <kbd className="rounded border border-border-default px-1">esc</kbd> dismiss
            </span>
          </div>
        </div>
      )}
      <div
        data-slot="composer-card"
        data-running={running || undefined}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || !running || stopDisabled || e.defaultPrevented) return
          // Escape inside an open Agent/Model list belongs to that list (portal events bubble through React to here).
          if (e.target instanceof Element && e.target.closest('[role="listbox"], [role="dialog"], [data-slot="popover-content"], [data-slot="sheet-content"]')) return
          e.preventDefault()
          e.stopPropagation()
          onStop()
        }}
        className={cn(
          "rounded-xl border border-input bg-card shadow-sm transition-[border-color,box-shadow] duration-150 motion-reduce:transition-none",
          "hover:border-border-strong focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25 hover:focus-within:border-ring",
          readOnly && "bg-muted/70 shadow-none hover:border-input",
        )}
      >
        {hasStrip && (
          <div data-slot="composer-strip" className="flex min-w-0 flex-wrap items-center gap-1.5 border-b border-border px-2.5 py-2">
            {status}
            {contextChips}
          </div>
        )}
        <div className="flex min-w-0 items-end gap-2 py-2.5 pr-2.5 pl-3.5">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              const nextVal = e.target.value
              const caret = e.target.selectionStart
              onChange(nextVal)
              detectMention(nextVal, caret)
            }}
            onClick={(e) => detectMention(e.currentTarget.value, e.currentTarget.selectionStart)}
            onKeyUp={(e) => {
              if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
                detectMention(e.currentTarget.value, e.currentTarget.selectionStart)
              }
            }}
            onBlur={() => window.setTimeout(closeMentions, 120)}
            onPaste={(e) => {
              if (!onPasteText) return
              if (onPasteText(e.clipboardData.getData("text/plain"))) e.preventDefault()
            }}
            onKeyDown={(e) => {
              if (mentionOpen && flatMentions.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault()
                  setActiveMentionIdx((prev) => (prev + 1) % flatMentions.length)
                  return
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault()
                  setActiveMentionIdx((prev) => (prev - 1 + flatMentions.length) % flatMentions.length)
                  return
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault()
                  const picked = flatMentions[Math.min(activeMentionIdx, flatMentions.length - 1)]
                  if (picked) selectMention(picked)
                  return
                }
                if (e.key === "Escape") {
                  e.preventDefault()
                  e.stopPropagation()
                  closeMentions()
                  return
                }
              }
              // Safari fires compositionend before the Enter that commits an IME candidate, so isComposing is already false
              // there; keyCode 229 ("processing") is what still marks that keydown.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault()
                send()
              }
            }}
            aria-label="Message the agent"
            aria-describedby={hintId}
            aria-controls={mentionOpen ? listId : undefined}
            aria-activedescendant={mentionOpen ? `${listId}-${Math.min(activeMentionIdx, flatMentions.length - 1)}` : undefined}
            aria-autocomplete="list"
            placeholder={running ? "Waiting for the answer…" : placeholder}
            rows={1}
            disabled={textareaDisabled}
            style={{ maxHeight: MAX_HEIGHT_PX }}
            // 16px on phones so iOS does not zoom the page when the field is focused.
            className="block min-h-[34px] min-w-0 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-0 py-1.5 text-base leading-[22px] text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:text-muted-foreground sm:text-sm"
          />
          <span id={hintId} className="sr-only">Enter to send. Shift+Enter for a new line.</span>
          {running ? (
            <Button
              key="stop"
              ref={stopRef}
              onFocus={() => { returnFocus.current = true }}
              // Only a blur that lands somewhere else cancels the intent; a blur with no target is the button unmounting.
              onBlur={(e) => { if (e.relatedTarget) returnFocus.current = false }}
              size="icon"
              disabled={stopDisabled}
              onClick={onStop}
              aria-label="Stop this agent run"
              title={stopTitle}
              className="size-9 shrink-0 rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              <Square className="size-3.5 fill-current" aria-hidden="true" />
            </Button>
          ) : (
            <Button key="send" size="icon" onClick={send} disabled={sendDisabled} aria-label="Send message" className="size-9 shrink-0 rounded-lg disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100">
              <ArrowUp className="size-4" aria-hidden="true" />
            </Button>
          )}
        </div>
        {chips && (
          <div data-slot="composer-footer" className="flex min-w-0 items-center gap-2 rounded-b-[inherit] border-t border-border bg-muted/60 p-2 @md/composer:px-2.5">
            {chips}
            <span aria-hidden="true" className="ml-auto hidden min-w-0 flex-1 truncate text-right text-[11px] text-muted-foreground @3xl/composer:block">Enter to send · Shift+Enter for a new line</span>
          </div>
        )}
      </div>
    </div>
  )
}
