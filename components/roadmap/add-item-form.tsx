"use client";

import { useState, useTransition, useRef } from "react";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { addRoadmapItem } from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions";
import type { RoadmapCardData } from "@/components/roadmap/roadmap-card";
import type { Horizon } from "@/lib/types";

type Props = {
  workspaceId: string;
  horizon: Horizon;
  revalidatePathStr: string;
  onAdd?: (item: RoadmapCardData) => void;
};

export function AddItemForm({ workspaceId, horizon, revalidatePathStr, onAdd }: Props) {
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
      const item = await addRoadmapItem(
        workspaceId,
        {
          title,
          description: (data.get("description") as string).trim() || undefined,
          horizon,
        },
        revalidatePathStr
      );
      onAdd?.({
        id: item.id,
        title: item.title,
        description: item.description ?? null,
        horizon: item.horizon as Horizon,
        sortOrder: item.sortOrder,
        solutionId: item.solutionId ?? null,
        keyResultId: item.keyResultId ?? null,
        solution: null,
        keyResult: null,
      });
      setOpen(false);
      formRef.current?.reset();
    });
  }

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="w-full text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        <PlusIcon className="size-3.5" />
        Add item
      </Button>
    );
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      className="rounded-xl ring-1 ring-border bg-muted/30 p-3 flex flex-col gap-3"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`item-title-${horizon}`}>Title</Label>
        <Input
          id={`item-title-${horizon}`}
          name="title"
          placeholder="What are you building?"
          autoFocus
          required
          disabled={isPending}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`item-description-${horizon}`}>
          Description (optional)
        </Label>
        <Textarea
          id={`item-description-${horizon}`}
          name="description"
          placeholder="Optional details..."
          disabled={isPending}
          rows={2}
        />
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? "Adding..." : "Add Item"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isPending}
          onClick={() => {
            setOpen(false);
            formRef.current?.reset();
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
