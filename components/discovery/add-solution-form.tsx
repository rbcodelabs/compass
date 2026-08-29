"use client";

import { useState, useTransition, useRef, useId } from "react";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { addSolution } from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";

type Props = {
  opportunityId: string;
  revalidatePathStr: string;
  /**
   * Called after a solution is created. The full page relies on
   * `revalidatePath` alone, but the opportunity panel fetches its own data
   * client-side, so it passes `refresh` here to pull the new solution into the
   * list instead of showing a stale one until reopened.
   */
  onAdded?: () => void;
};

export function AddSolutionForm({ opportunityId, revalidatePathStr, onAdded }: Props) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  // Unique per instance: the opportunity panel can be open *on* the opportunity
  // full page (hop to it from a solution panel's Opportunity relation), which
  // renders this form twice. Hardcoded ids would duplicate, silently breaking
  // label→input association and making getByLabel("Title") ambiguous.
  const uid = useId();
  const titleId = `sol-title-${uid}`;
  const descId = `sol-description-${uid}`;

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const title = (data.get("title") as string).trim();
    if (!title) return;

    startTransition(async () => {
      await addSolution(
        opportunityId,
        {
          title,
          description: (data.get("description") as string).trim() || undefined,
        },
        revalidatePathStr
      );
      formRef.current?.reset();
      setOpen(false);
      onAdded?.();
    });
  }

  if (!open) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() => setOpen(true)}
      >
        <PlusIcon />
        Add Solution
      </Button>
    );
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      className="rounded-xl ring-1 ring-border bg-muted/30 p-4 flex flex-col gap-3"
    >
      <p className="text-sm font-medium">New Solution</p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={titleId}>Title</Label>
        <Input
          id={titleId}
          name="title"
          placeholder="Solution title"
          autoFocus
          required
          disabled={isPending}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={descId}>Description (optional)</Label>
        <Textarea
          id={descId}
          name="description"
          placeholder="Describe the solution approach..."
          disabled={isPending}
        />
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? "Adding..." : "Add Solution"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isPending}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
