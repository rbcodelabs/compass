"use client";

import * as React from "react";
import { useState, useTransition, useRef, useEffect } from "react";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { addRoadmapItem } from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions";
import type { RoadmapCardData } from "@/components/roadmap/roadmap-card";
import type { Horizon } from "@/lib/types";

type Props = {
  workspaceId: string;
  defaultHorizon?: Horizon;
  revalidatePathStr: string;
  /** Called after the item is persisted, with the new item's data. */
  onAdd?: (item: RoadmapCardData) => void;
  /** If provided, the dialog is controlled externally (no trigger button rendered). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function AddItemDialog({
  workspaceId,
  defaultHorizon = "NOW",
  revalidatePathStr,
  onAdd,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: Props) {
  const isControlled = controlledOpen !== undefined;
  const [internalOpen, setInternalOpen] = useState(false);
  const open = isControlled ? controlledOpen : internalOpen;

  function setOpen(value: boolean) {
    if (isControlled) {
      controlledOnOpenChange?.(value);
    } else {
      setInternalOpen(value);
    }
  }

  const [isPending, startTransition] = useTransition();
  const [horizon, setHorizon] = useState<Horizon>(defaultHorizon);
  const formRef = useRef<HTMLFormElement>(null);

  // When the defaultHorizon prop changes (e.g. user clicks "+" on a different column),
  // reset the horizon select to match.
  useEffect(() => {
    setHorizon(defaultHorizon);
  }, [defaultHorizon]);

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
      setHorizon(defaultHorizon);
    });
  }

  const dialogContent = (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Add Roadmap Item</DialogTitle>
      </DialogHeader>
      <form ref={formRef} onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="item-title">Title</Label>
          <Input
            id="item-title"
            name="title"
            placeholder="What are you building?"
            required
            disabled={isPending}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="item-description">Description</Label>
          <Textarea
            id="item-description"
            name="description"
            placeholder="Optional details..."
            disabled={isPending}
            rows={3}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="item-horizon">Horizon</Label>
          <Select
            value={horizon}
            onValueChange={(v: string | null) => { if (v) setHorizon(v as Horizon) }}
            disabled={isPending}
          >
            <SelectTrigger id="item-horizon" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="NOW">Now</SelectItem>
              <SelectItem value="NEXT">Next</SelectItem>
              <SelectItem value="LATER">Later</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <DialogFooter showCloseButton>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Adding..." : "Add Item"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );

  if (isControlled) {
    // Controlled mode: no trigger button, caller manages open state.
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        {dialogContent}
      </Dialog>
    );
  }

  // Uncontrolled mode: renders with a trigger button.
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <PlusIcon />
        Add Item
      </DialogTrigger>
      {dialogContent}
    </Dialog>
  );
}
