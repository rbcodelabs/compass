"use client";

import { useRef, useState, useTransition } from "react";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createObjective } from "@/app/[orgSlug]/[workspaceSlug]/okrs/actions";

interface AddObjectiveFormProps {
  cycleId: string;
  orgSlug: string;
  workspaceSlug: string;
}

export function AddObjectiveForm({
  cycleId,
  orgSlug,
  workspaceSlug,
}: AddObjectiveFormProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  function handleSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      try {
        await createObjective(cycleId, orgSlug, workspaceSlug, formData);
        setOpen(false);
        formRef.current?.reset();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong");
      }
    });
  }

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        <PlusIcon />
        Add Objective
      </Button>
    );
  }

  return (
    <form
      ref={formRef}
      action={handleSubmit}
      className="rounded-xl ring-1 ring-border bg-muted/30 p-4 flex flex-col gap-3 w-full max-w-sm"
    >
      <p className="text-sm font-medium">Add Objective</p>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="obj-title">Title</Label>
        <Input
          id="obj-title"
          name="title"
          placeholder="Grow user engagement"
          autoFocus
          required
          disabled={isPending}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="obj-description">Description (optional)</Label>
        <Textarea
          id="obj-description"
          name="description"
          placeholder="What does success look like?"
          rows={3}
          disabled={isPending}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="obj-owner">Owner (optional)</Label>
        <Input
          id="obj-owner"
          name="owner"
          placeholder="e.g. Product team"
          disabled={isPending}
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? "Adding…" : "Add objective"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isPending}
          onClick={() => {
            setOpen(false);
            setError(null);
            formRef.current?.reset();
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
