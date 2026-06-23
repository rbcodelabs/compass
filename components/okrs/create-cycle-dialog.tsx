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
import { createCycle } from "@/app/[orgSlug]/[workspaceSlug]/okrs/actions";

interface CreateCycleDialogProps {
  workspaceId: string;
  orgSlug: string;
  workspaceSlug: string;
}

export function CreateCycleDialog({
  workspaceId,
  orgSlug,
  workspaceSlug,
}: CreateCycleDialogProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  function handleSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      try {
        await createCycle(workspaceId, orgSlug, workspaceSlug, formData);
        // redirect() in the action throws internally, so this only runs on error
      } catch (err) {
        // Next.js redirect throws a special error — let it propagate
        if (
          err instanceof Error &&
          err.message.includes("NEXT_REDIRECT")
        ) {
          throw err;
        }
        setError(err instanceof Error ? err.message : "Something went wrong");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>New Cycle</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create OKR Cycle</DialogTitle>
        </DialogHeader>

        <form ref={formRef} action={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cycle-title">Title</Label>
            <Input
              id="cycle-title"
              name="title"
              placeholder="Q3 2025"
              required
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cycle-start">Start date</Label>
            <Input
              id="cycle-start"
              name="startDate"
              type="date"
              required
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cycle-end">End date</Label>
            <Input
              id="cycle-end"
              name="endDate"
              type="date"
              required
            />
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <DialogFooter>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Creating…" : "Create cycle"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
