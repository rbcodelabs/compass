"use client"

// The inline answer shown inside the Cmd+K palette while (and after) the agent
// answers a quick question. Purely presentational: the turn itself is run by
// useAgentTurn in the palette.

import { ArrowLeft, Loader2, Square } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Markdown } from "@/components/agent/markdown"
import type { ToolStep } from "@/lib/agent-run-stream"

type Props = {
  question: string
  /** Agent phase while a turn is in flight. */
  phase: "idle" | "booting" | "running"
  streamingText: string
  steps: ToolStep[]
  /** The finished reply, once the turn settled. */
  answer: string | null
  error: string | null
  canPromote: boolean
  onStop: () => void
  onPromote: () => void
  onRetry: () => void
  onBack: () => void
}

export function PaletteAskAnswer({
  question,
  phase,
  streamingText,
  steps,
  answer,
  error,
  canPromote,
  onStop,
  onPromote,
  onRetry,
  onBack,
}: Props) {
  const running = phase !== "idle"
  const body = running ? streamingText : answer
  const currentStep = [...steps].reverse().find((step) => step.status === "running")
  const status =
    phase === "booting" ? "Starting the agent…" : running && !streamingText && !currentStep ? "Thinking…" : currentStep?.label ?? null

  return (
    <div className="flex max-h-[calc(70vh-3.5rem)] flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <p className="mb-2 truncate text-xs font-medium text-muted-foreground" title={question}>{question}</p>
        <div aria-live="polite" aria-busy={running}>
          {body ? <Markdown>{body}</Markdown> : null}
          {running && status && (
            <p role="status" className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" aria-hidden="true" />
              {status}
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className="mt-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 border-t px-4 py-2">
        {running ? (
          <Button type="button" variant="outline" size="sm" onClick={onStop}>
            <Square aria-hidden="true" /> Stop
            <kbd className="ml-1 text-[10px] text-muted-foreground">Esc</kbd>
          </Button>
        ) : (
          <>
            <Button type="button" variant="ghost" size="sm" onClick={onBack}>
              <ArrowLeft aria-hidden="true" /> Back
            </Button>
            {error && (
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                Try again
              </Button>
            )}
          </>
        )}
        <Button
          type="button"
          size="sm"
          className="ml-auto"
          disabled={!canPromote}
          title={canPromote ? undefined : "Available once the agent has started a thread"}
          onClick={onPromote}
        >
          Open in Agent <kbd className="ml-1 text-[10px] opacity-80">⌘↵</kbd>
        </Button>
      </div>
    </div>
  )
}
