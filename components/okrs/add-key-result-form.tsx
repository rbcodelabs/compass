"use client";

import { useRef, useState, useTransition } from "react";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import { addKeyResult } from "@/app/[orgSlug]/[workspaceSlug]/okrs/actions";

interface AddKeyResultFormProps {
  objectiveId: string;
  objectiveTitle: string;
  orgSlug: string;
  workspaceSlug: string;
  /**
   * Controlled open state. When provided, the form renders nothing while closed
   * (the parent supplies its own trigger, e.g. a ⋯ menu item). When omitted, the
   * form manages its own state and renders an inline "Add" button.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function AddKeyResultForm({
  objectiveId,
  objectiveTitle,
  orgSlug,
  workspaceSlug,
  open: controlledOpen,
  onOpenChange,
}: AddKeyResultFormProps) {
  const labels = useLabels();
  const isControlled = controlledOpen !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
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
    if (isControlled) return null;
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <PlusIcon className="size-3.5" />
        Add {labels.keyResult.lower}
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
        Add {labels.keyResult.singular}
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
          {isPending ? "Adding…" : `Add ${labels.keyResult.lower}`}
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
