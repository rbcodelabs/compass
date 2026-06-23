"use client"

import { useState, useTransition } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { concludeExperiment } from "@/app/[orgSlug]/[workspaceSlug]/experiments/actions"

type Conclusion = "PROCEED" | "KILL" | "ITERATE"

interface ConcludeDialogProps {
  experimentId: string
  killCondition: string
  trigger: React.ReactElement
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
}

export function ConcludeDialog({
  experimentId,
  killCondition,
  trigger,
}: ConcludeDialogProps) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<Conclusion | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleConclude() {
    if (!selected) return

    startTransition(async () => {
      await concludeExperiment(experimentId, selected)
      setOpen(false)
      setSelected(null)
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Conclude Experiment</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
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
            {(["PROCEED", "ITERATE", "KILL"] as Conclusion[]).map((c) => {
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

          <div className="flex justify-end">
            <Button
              onClick={handleConclude}
              disabled={!selected || isPending}
              variant={selected === "KILL" ? "destructive" : "default"}
            >
              {isPending
                ? "Concluding..."
                : selected
                  ? `Conclude as ${CONCLUSION_CONFIG[selected].label}`
                  : "Select a conclusion"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
