"use client"

// The agent chat composer: one rounded card holding an optional top strip (run status and context chips), the
// auto-growing message field with its send/stop button, and a footer tray for the Agent and Model chips.
// It is presentational: AgentChat owns the state and the semantics (what is disabled, what stop does).

import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react"
import { ArrowUp, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const MAX_HEIGHT_PX = 150

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
}

export function ComposerCard(props: Props) {
  const { textareaRef, value, onChange, onSend, placeholder = "Message the agent…", textareaDisabled, sendDisabled, running, onStop, stopDisabled, stopTitle, status, contextChips, chips, readOnly } = props
  const stopRef = useRef<HTMLButtonElement>(null)
  const wasRunning = useRef(running)
  // Tracked by events because Stop unmounts when the run ends, and an unmounted element cannot be asked whether it had focus.
  const stopFocused = useRef(false)

  // Grow with the content up to MAX_HEIGHT_PX, then scroll. Done in script (not field-sizing) so every browser agrees.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`
  }, [value, textareaRef])

  // Sending disables the field, which drops focus to <body>; park it on Stop so Escape keeps working, and give it
  // back to the field when the run ends (only if Stop still had it, so a user who moved on is not pulled back).
  useEffect(() => {
    if (running && !wasRunning.current) {
      const active = document.activeElement
      if (!active || active === document.body || active === textareaRef.current) stopRef.current?.focus()
    } else if (!running && wasRunning.current && stopFocused.current) {
      textareaRef.current?.focus()
    }
    if (!running) stopFocused.current = false
    wasRunning.current = running
  }, [running, textareaRef])

  const hasStrip = Boolean(status) || Boolean(contextChips)

  return (
    <div className="@container/composer mx-auto w-full max-w-3xl min-w-0">
      <div
        data-slot="composer-card"
        data-running={running || undefined}
        onKeyDown={(e) => {
          if (e.key === "Escape" && running && !stopDisabled && !e.defaultPrevented) {
            e.preventDefault()
            e.stopPropagation()
            onStop()
          }
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
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                onSend()
              }
            }}
            placeholder={running ? "Waiting for the answer…" : placeholder}
            rows={1}
            disabled={textareaDisabled}
            // 16px on phones so iOS does not zoom the page when the field is focused.
            className="block max-h-[150px] min-h-[34px] min-w-0 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-0 py-1.5 text-base leading-[22px] text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:text-muted-foreground sm:text-sm"
          />
          {running ? (
            <Button
              key="stop"
              ref={stopRef}
              onFocus={() => { stopFocused.current = true }}
              onBlur={() => { stopFocused.current = false }}
              size="icon"
              disabled={stopDisabled}
              onClick={onStop}
              aria-label="Stop this agent run"
              title={stopTitle}
              className="size-[34px] shrink-0 rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              <Square className="size-3.5 fill-current" aria-hidden="true" />
            </Button>
          ) : (
            <Button key="send" size="icon" onClick={onSend} disabled={sendDisabled} aria-label="Send message" className="size-[34px] shrink-0 rounded-lg disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100">
              <ArrowUp className="size-4" aria-hidden="true" />
            </Button>
          )}
        </div>
        {chips && (
          <div data-slot="composer-footer" className="flex min-w-0 items-center gap-2 rounded-b-[inherit] border-t border-border bg-muted/60 p-2 @md/composer:px-2.5">
            {chips}
            <span className="ml-auto hidden min-w-0 flex-1 truncate text-right text-xs text-muted-foreground @xl/composer:block">Enter to send · Shift+Enter for a new line</span>
          </div>
        )}
      </div>
    </div>
  )
}
