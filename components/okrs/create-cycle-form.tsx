"use client";

import { useRef, useState, useTransition } from "react";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createCycle } from "@/app/[orgSlug]/[workspaceSlug]/okrs/actions";

interface CreateCycleFormProps {
  workspaceId: string;
  orgSlug: string;
  workspaceSlug: string;
}

export function CreateCycleForm({
  workspaceId,
  orgSlug,
  workspaceSlug,
}: CreateCycleFormProps) {
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
        if (err instanceof Error && err.message.includes("NEXT_REDIRECT")) {
          throw err;
        }
        setError(err instanceof Error ? err.message : "Something went wrong");
      }
    });
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>
        <PlusIcon />
        New Cycle
      </Button>
    );
  }

  return (
    <form
      ref={formRef}
      action={handleSubmit}
      className="rounded-xl ring-1 ring-border bg-muted/30 p-4 flex flex-col gap-3 w-full max-w-sm"
    >
      <p className="text-sm font-medium">New OKR Cycle</p>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="cycle-title">Title</Label>
        <Input
          id="cycle-title"
          name="title"
          placeholder="Q3 2025"
          autoFocus
          required
          disabled={isPending}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="cycle-start">Start date</Label>
        <Input
          id="cycle-start"
          name="startDate"
          type="date"
          required
          disabled={isPending}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="cycle-end">End date</Label>
        <Input
          id="cycle-end"
          name="endDate"
          type="date"
          required
          disabled={isPending}
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? "Creating…" : "Create cycle"}
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
