"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { concludeExperiment } from "@/app/[orgSlug]/[workspaceSlug]/experiments/actions"

type Conclusion = "PROCEED" | "KILL" | "ITERATE" | "NOT_PURSUED"

interface ConcludePanelProps {
  experimentId: string
  killCondition: string
}

const CONCLUSION_CONFIG: Record<
  Conclusion,
  { label: string; description: string; className: string }
> = {
  PROCEED: {
    label: "Proceed",
    description: "Hypothesis validated — move forward",
    className:
      "border-green-300 bg-green-50 text-green-800 hover:bg-green-100 dark:border-green-700 dark:bg-green-950/30 dark:text-green-300 dark:hover:bg-green-950/50",
  },
  ITERATE: {
    label: "Iterate",
    description: "Inconclusive — refine and try again",
    className:
      "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300 dark:hover:bg-amber-950/50",
  },
  KILL: {
    label: "Kill",
    description: "Hypothesis invalidated — stop here",
    className:
      "border-red-300 bg-red-50 text-red-800 hover:bg-red-100 dark:border-red-700 dark:bg-red-950/30 dark:text-red-300 dark:hover:bg-red-950/50",
  },
  NOT_PURSUED: {
    label: "Not Pursued",
    description: "Deliberately not running this — no evidence either way",
    // Semantic status tokens, which already carry their own dark-mode values —
    // hence no `dark:` variants here. The three options above still use raw
    // palette values and remain in docs/design/raw-color-baseline.json; they are
    // legacy awaiting the same treatment, not a different convention.
    className:
      "border-status-neutral/30 bg-status-neutral-surface text-status-neutral hover:bg-status-neutral-surface/70",
  },
}

export function ConcludePanel({ experimentId, killCondition }: ConcludePanelProps) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<Conclusion | null>(null)
  const [reason, setReason] = useState("")
  const [isPending, startTransition] = useTransition()

  const reasonRequired = selected === "NOT_PURSUED"
  const canSubmit = Boolean(selected) && (!reasonRequired || reason.trim().length > 0)

  function handleConclude() {
    if (!selected || !canSubmit) return

    startTransition(async () => {
      await concludeExperiment(experimentId, selected, reason.trim() || undefined)
      setOpen(false)
      setSelected(null)
      setReason("")
    })
  }

  if (!open) {
    return (
      <Button variant="outline" className="w-full" onClick={() => setOpen(true)}>
        Conclude Experiment
      </Button>
    )
  }

  return (
    <div className="rounded-xl ring-1 ring-border bg-muted/30 p-4 flex flex-col gap-4">
      <p className="text-sm font-medium">Conclude Experiment</p>

      {/* Kill condition reminder — always shown */}
      <div className="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30 px-3 py-2.5 flex gap-2">
        <span
          aria-hidden="true"
          className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5"
        >
          &#9888;
        </span>
        <div className="flex flex-col gap-0.5">
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
            Kill condition
          </p>
          <p className="text-sm text-amber-800 dark:text-amber-300">
            {killCondition}
          </p>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        Choose a conclusion. This cannot be undone.
      </p>

      <div className="flex flex-col gap-2">
        {(["PROCEED", "ITERATE", "KILL", "NOT_PURSUED"] as Conclusion[]).map((c) => {
          const config = CONCLUSION_CONFIG[c]
          const isSelected = selected === c
          return (
            <button
              key={c}
              type="button"
              onClick={() => setSelected(c)}
              className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${config.className} ${
                isSelected ? "ring-2 ring-offset-1 ring-current" : ""
              }`}
            >
              <p className="font-medium text-sm">{config.label}</p>
              <p className="text-xs opacity-75">{config.description}</p>
            </button>
          )
        })}
      </div>

      {selected && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="conclude-reason" className="text-xs font-medium text-muted-foreground">
            Reason{reasonRequired ? " (required)" : " (optional)"}
          </label>
          <Textarea
            id="conclude-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={
              reasonRequired
                ? "Why are you closing this without running it? (e.g. the feature already shipped and works)"
                : "Add context for this conclusion..."
            }
            rows={3}
            className="text-sm"
          />
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          onClick={handleConclude}
          disabled={!canSubmit || isPending}
          size="sm"
          variant={selected === "KILL" ? "destructive" : selected === "NOT_PURSUED" ? "secondary" : "default"}
        >
          {isPending
            ? "Concluding..."
            : selected
              ? `Conclude as ${CONCLUSION_CONFIG[selected].label}`
              : "Select a conclusion"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isPending}
          onClick={() => {
            setOpen(false)
            setSelected(null)
            setReason("")
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}
