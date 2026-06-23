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
import { addKeyResult } from "@/app/[orgSlug]/[workspaceSlug]/okrs/actions";

interface AddKeyResultDialogProps {
  objectiveId: string;
  objectiveTitle: string;
  orgSlug: string;
  workspaceSlug: string;
}

export function AddKeyResultDialog({
  objectiveId,
  objectiveTitle,
  orgSlug,
  workspaceSlug,
}: AddKeyResultDialogProps) {
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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>
        Add key result
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Key Result</DialogTitle>
          <p className="text-sm text-muted-foreground">{objectiveTitle}</p>
        </DialogHeader>

        <form ref={formRef} action={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kr-title">Title</Label>
            <Input
              id="kr-title"
              name="title"
              placeholder="Weekly active users"
              required
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
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="kr-unit">Unit (optional)</Label>
              <Input
                id="kr-unit"
                name="unit"
                placeholder="users, %, NPS…"
              />
            </div>
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <DialogFooter>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Adding…" : "Add key result"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
