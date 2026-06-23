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
import { logCheckIn } from "@/app/[orgSlug]/[workspaceSlug]/okrs/actions";

interface CheckInDialogProps {
  keyResultId: string;
  keyResultTitle: string;
  currentValue: number;
  orgSlug: string;
  workspaceSlug: string;
}

export function CheckInDialog({
  keyResultId,
  keyResultTitle,
  currentValue,
  orgSlug,
  workspaceSlug,
}: CheckInDialogProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  function handleSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      try {
        await logCheckIn(keyResultId, orgSlug, workspaceSlug, formData);
        setOpen(false);
        formRef.current?.reset();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        Check in
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log check-in</DialogTitle>
          <p className="text-sm text-muted-foreground">{keyResultTitle}</p>
        </DialogHeader>

        <form ref={formRef} action={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="checkin-value">Current value</Label>
            <Input
              id="checkin-value"
              name="value"
              type="number"
              step="any"
              defaultValue={currentValue}
              required
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="checkin-note">Note (optional)</Label>
            <Textarea
              id="checkin-note"
              name="note"
              placeholder="What happened since the last check-in?"
              rows={3}
            />
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <DialogFooter>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Saving…" : "Save check-in"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
