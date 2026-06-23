"use client"

import { useRef, useState, useTransition } from "react"
import { PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { logResult } from "@/app/[orgSlug]/[workspaceSlug]/experiments/actions"

interface LogResultFormProps {
  experimentId: string
}

export function LogResultForm({ experimentId }: LogResultFormProps) {
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const formRef = useRef<HTMLFormElement>(null)

  function handleSubmit(formData: FormData) {
    const note = formData.get("note") as string
    const metric = (formData.get("metric") as string) || undefined
    const rawValue = formData.get("value") as string
    const value = rawValue ? parseFloat(rawValue) : undefined

    if (!note) return

    startTransition(async () => {
      await logResult(experimentId, { note, metric, value })
      setOpen(false)
      formRef.current?.reset()
    })
  }

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        <PlusIcon className="size-4" />
        Log Result
      </Button>
    )
  }

  return (
    <form
      ref={formRef}
      action={handleSubmit}
      className="rounded-xl ring-1 ring-border bg-muted/30 p-4 flex flex-col gap-3"
    >
      <p className="text-sm font-medium">Log Result</p>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="result-note">Note</Label>
        <Textarea
          id="result-note"
          name="note"
          placeholder="What did you observe?"
          required
          rows={3}
          autoFocus
          disabled={isPending}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="result-metric">Metric (optional)</Label>
          <Input
            id="result-metric"
            name="metric"
            placeholder="e.g. conversion_rate"
            disabled={isPending}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="result-value">Value (optional)</Label>
          <Input
            id="result-value"
            name="value"
            type="number"
            step="any"
            placeholder="e.g. 0.12"
            disabled={isPending}
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? "Logging..." : "Log Result"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isPending}
          onClick={() => {
            setOpen(false)
            formRef.current?.reset()
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}
