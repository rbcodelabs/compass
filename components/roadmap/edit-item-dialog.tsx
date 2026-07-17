"use client";

import { useEffect, useState, useTransition } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { updateRoadmapItem } from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions";
import type { RoadmapCardData } from "./roadmap-card";

// Convert an ISO date string (or null) to the yyyy-mm-dd shape <input type="date"> expects.
function toDateInputValue(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

type Props = {
  item: RoadmapCardData;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  revalidatePathStr: string;
  onSaved: (item: RoadmapCardData) => void;
};

export function EditItemDialog({ item, open, onOpenChange, revalidatePathStr, onSaved }: Props) {
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description ?? "");
  const [startDate, setStartDate] = useState(toDateInputValue(item.startDate));
  const [endDate, setEndDate] = useState(toDateInputValue(item.endDate));
  const [isPending, startTransition] = useTransition();

  // Reset local form state whenever the dialog is (re)opened for this item.
  useEffect(() => {
    if (open) {
      setTitle(item.title);
      setDescription(item.description ?? "");
      setStartDate(toDateInputValue(item.startDate));
      setEndDate(toDateInputValue(item.endDate));
    }
  }, [open, item]);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;

    startTransition(async () => {
      const updated = await updateRoadmapItem(
        item.id,
        {
          title: trimmedTitle,
          description: description.trim() || undefined,
          startDate: startDate ? new Date(startDate) : null,
          endDate: endDate ? new Date(endDate) : null,
        },
        revalidatePathStr
      );

      onSaved({
        ...item,
        title: updated.title,
        description: updated.description ?? null,
        startDate: updated.startDate ? updated.startDate.toISOString() : null,
        endDate: updated.endDate ? updated.endDate.toISOString() : null,
      });
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Edit roadmap item</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`edit-title-${item.id}`}>Title</Label>
            <Input
              id={`edit-title-${item.id}`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              disabled={isPending}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`edit-description-${item.id}`}>Description</Label>
            <Textarea
              id={`edit-description-${item.id}`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={isPending}
              rows={2}
            />
          </div>

          <div className="flex gap-3">
            <div className="flex flex-col gap-1.5 flex-1">
              <Label htmlFor={`edit-start-date-${item.id}`}>Start date</Label>
              <Input
                id={`edit-start-date-${item.id}`}
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                disabled={isPending}
              />
            </div>
            <div className="flex flex-col gap-1.5 flex-1">
              <Label htmlFor={`edit-end-date-${item.id}`}>End date</Label>
              <Input
                id={`edit-end-date-${item.id}`}
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                disabled={isPending}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" size="sm" disabled={isPending}>
              {isPending ? "Saving..." : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
