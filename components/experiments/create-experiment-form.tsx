"use client"

import { useRef, useState, useTransition } from "react"
import { PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { createExperiment } from "@/app/[orgSlug]/[workspaceSlug]/experiments/actions"

interface CreateExperimentFormProps {
  workspaceId: string
}

export function CreateExperimentForm({ workspaceId }: CreateExperimentFormProps) {
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const formRef = useRef<HTMLFormElement>(null)

  function handleSubmit(formData: FormData) {
    const title = formData.get("title") as string
    const hypothesis = formData.get("hypothesis") as string
    const method = formData.get("method") as string
    const killCondition = formData.get("killCondition") as string

    if (!title || !hypothesis || !method || !killCondition) return

    startTransition(async () => {
      await createExperiment(workspaceId, {
        title,
        hypothesis,
        method,
        killCondition,
      })
      setOpen(false)
      formRef.current?.reset()
    })
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>
        <PlusIcon />
        New Experiment
      </Button>
    )
  }

  return (
    <form
      ref={formRef}
      action={handleSubmit}
      className="rounded-xl ring-1 ring-border bg-muted/30 p-4 flex flex-col gap-3 w-full max-w-lg"
    >
      <p className="text-sm font-medium">New Experiment</p>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="exp-title">Title</Label>
        <Input
          id="exp-title"
          name="title"
          placeholder="What are you testing?"
          autoFocus
          required
          disabled={isPending}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="exp-hypothesis">Hypothesis</Label>
        <Textarea
          id="exp-hypothesis"
          name="hypothesis"
          placeholder="We believe that..."
          required
          rows={3}
          disabled={isPending}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="exp-method">Method</Label>
        <Textarea
          id="exp-method"
          name="method"
          placeholder="We will test this by..."
          required
          rows={3}
          disabled={isPending}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label
          htmlFor="exp-kill-condition"
          className="flex items-center gap-1.5"
        >
          <span aria-hidden="true" className="text-amber-500">
            &#9888;
          </span>
          Kill Condition
        </Label>
        <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20 p-1">
          <Textarea
            id="exp-kill-condition"
            name="killCondition"
            placeholder="We will kill this experiment if..."
            required
            rows={2}
            disabled={isPending}
            className="border-0 bg-transparent focus-visible:ring-0 ring-0"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Define the hard gate before you start. This will be shown prominently
          during the experiment.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? "Creating..." : "Create Experiment"}
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
