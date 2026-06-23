"use client";

import { useState, useTransition, useRef } from "react";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { addSolution } from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";

type Props = {
  opportunityId: string;
  revalidatePathStr: string;
};

export function AddSolutionForm({ opportunityId, revalidatePathStr }: Props) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

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
        <Label htmlFor="sol-title">Title</Label>
        <Input
          id="sol-title"
          name="title"
          placeholder="Solution title"
          autoFocus
          required
          disabled={isPending}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="sol-description">Description (optional)</Label>
        <Textarea
          id="sol-description"
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
