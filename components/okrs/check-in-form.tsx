"use client";

import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { logCheckIn } from "@/app/[orgSlug]/[workspaceSlug]/okrs/actions";

interface CheckInFormProps {
  keyResultId: string;
  keyResultTitle: string;
  currentValue: number;
  orgSlug: string;
  workspaceSlug: string;
}

export function CheckInForm({
  keyResultId,
  keyResultTitle,
  currentValue,
  orgSlug,
  workspaceSlug,
}: CheckInFormProps) {
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

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Check in
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
        Log check-in
        <span className="ml-1 font-normal text-muted-foreground">
          — {keyResultTitle}
        </span>
      </p>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="checkin-value">Current value</Label>
        <Input
          id="checkin-value"
          name="value"
          type="number"
          step="any"
          defaultValue={currentValue}
          autoFocus
          required
          disabled={isPending}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="checkin-note">Note (optional)</Label>
        <Textarea
          id="checkin-note"
          name="note"
          placeholder="What happened since the last check-in?"
          rows={3}
          disabled={isPending}
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? "Saving…" : "Save check-in"}
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
