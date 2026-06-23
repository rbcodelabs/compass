"use client"

import { useRef, useState, useTransition } from "react"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { logResult } from "@/app/[orgSlug]/[workspaceSlug]/experiments/actions"

interface LogResultDialogProps {
  experimentId: string
  trigger: React.ReactElement
}

export function LogResultDialog({
  experimentId,
  trigger,
}: LogResultDialogProps) {
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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Log Result</DialogTitle>
        </DialogHeader>

        <form ref={formRef} action={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="result-note">Note</Label>
            <Textarea
              id="result-note"
              name="note"
              placeholder="What did you observe?"
              required
              rows={3}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="result-metric">Metric (optional)</Label>
              <Input
                id="result-metric"
                name="metric"
                placeholder="e.g. conversion_rate"
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
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Logging..." : "Log Result"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
