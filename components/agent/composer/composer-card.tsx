"use client"

// The agent chat composer: one rounded card holding an optional top strip (run status and context chips), the
// auto-growing message field with its send/stop button, and a footer tray for the Agent and Model chips.
// It is presentational: AgentChat owns the state and the semantics (what is disabled, what stop does).

import { useEffect, useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react"
import { ArrowUp, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const MAX_HEIGHT_PX = 150
/** A send from this composer moves focus to Stop only if the run starts within this window; later runs are not ours to react to. */
const SEND_INTENT_MS = 10_000

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
  /** Greys the card like a read-only surface (access lost). */
  readOnly?: boolean
  /** False when someone else started the run being watched: their run never moves this user's focus. Default true. */
  runStartedByMe?: boolean
}

export function ComposerCard(props: Props) {
  const { textareaRef, value, onChange, onSend, placeholder = "Message the agent…", textareaDisabled, sendDisabled, running, onStop, stopDisabled, stopTitle, status, contextChips, chips, readOnly, runStartedByMe = true } = props
  const hintId = useId()
  const stopRef = useRef<HTMLButtonElement>(null)
  const wasRunning = useRef(running)
  // Focus intent is recorded from events, not read back from the DOM: sending disables the field and Stop unmounts when the
  // run ends, and browsers disagree on whether (and in what order) blur fires for an element that is disabled or removed.
  const sentAt = useRef(0)
  const returnFocus = useRef(false)

  const send = () => {
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

  return (
    <div className="@container/composer mx-auto w-full max-w-3xl min-w-0">
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
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              // Safari fires compositionend before the Enter that commits an IME candidate, so isComposing is already false
              // there; keyCode 229 ("processing") is what still marks that keydown.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault()
                send()
              }
            }}
            aria-label="Message the agent"
            aria-describedby={hintId}
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
