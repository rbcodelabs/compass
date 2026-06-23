"use client";

import { useRef, useState, useTransition } from "react";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addKeyResult } from "@/app/[orgSlug]/[workspaceSlug]/okrs/actions";

interface AddKeyResultFormProps {
  objectiveId: string;
  objectiveTitle: string;
  orgSlug: string;
  workspaceSlug: string;
}

export function AddKeyResultForm({
  objectiveId,
  objectiveTitle,
  orgSlug,
  workspaceSlug,
}: AddKeyResultFormProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  function handleSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      try {
        await addKeyResult(objectiveId, orgSlug, workspaceSlug, formData);
        setOpen(false);
        formRef.current?.reset();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong");
      }
    });
  }

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <PlusIcon className="size-3.5" />
        Add key result
      </Button>
    );
  }

  return (
    <form
      ref={formRef}
      action={handleSubmit}
      className="rounded-xl ring-1 ring-border bg-muted/30 p-4 flex flex-col gap-3"
    >
      <p className="text-sm font-medium">
        Add Key Result
        <span className="ml-1 font-normal text-muted-foreground">
          — {objectiveTitle}
        </span>
      </p>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="kr-title">Title</Label>
        <Input
          id="kr-title"
          name="title"
          placeholder="Weekly active users"
          autoFocus
          required
          disabled={isPending}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="kr-target">Target</Label>
          <Input
            id="kr-target"
            name="target"
            type="number"
            step="any"
            min="0"
            placeholder="1000"
            required
            disabled={isPending}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="kr-unit">Unit (optional)</Label>
          <Input
            id="kr-unit"
            name="unit"
            placeholder="users, %, NPS…"
            disabled={isPending}
          />
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? "Adding…" : "Add key result"}
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
