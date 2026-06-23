"use client";

import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createObjective } from "@/app/[orgSlug]/[workspaceSlug]/okrs/actions";

interface AddObjectiveDialogProps {
  cycleId: string;
  orgSlug: string;
  workspaceSlug: string;
}

export function AddObjectiveDialog({
  cycleId,
  orgSlug,
  workspaceSlug,
}: AddObjectiveDialogProps) {
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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" />}>
        Add Objective
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Objective</DialogTitle>
        </DialogHeader>

        <form ref={formRef} action={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="obj-title">Title</Label>
            <Input
              id="obj-title"
              name="title"
              placeholder="Grow user engagement"
              required
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="obj-description">Description (optional)</Label>
            <Textarea
              id="obj-description"
              name="description"
              placeholder="What does success look like?"
              rows={3}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="obj-owner">Owner (optional)</Label>
            <Input
              id="obj-owner"
              name="owner"
              placeholder="e.g. Product team"
            />
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <DialogFooter>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Adding…" : "Add objective"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
