"use client";

import { useRef, useState, useTransition } from "react";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Combobox,
  ComboboxContent,
  ComboboxTrigger,
  ComboboxValue,
} from "@/components/ui/combobox";
import { createObjective } from "@/app/[orgSlug]/[workspaceSlug]/okrs/actions";
import type { SquadData } from "@/lib/types";

interface AddObjectiveFormProps {
  cycleId: string;
  orgSlug: string;
  workspaceSlug: string;
  squads?: SquadData[];
}

export function AddObjectiveForm({
  cycleId,
  orgSlug,
  workspaceSlug,
  squads = [],
}: AddObjectiveFormProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [squadId, setSquadId] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  function handleSubmit(formData: FormData) {
    setError(null);
    if (squadId) formData.set("squadId", squadId);
    startTransition(async () => {
      try {
        await createObjective(cycleId, orgSlug, workspaceSlug, formData);
        setOpen(false);
        setSquadId(null);
        formRef.current?.reset();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong");
      }
    });
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 w-full rounded-lg border border-dashed border-border/60 py-2 px-3 text-xs text-muted-foreground hover:text-foreground hover:border-border transition-colors"
      >
        <PlusIcon className="w-3.5 h-3.5" />
        Add objective
      </button>
    );
  }

  return (
    <form
      ref={formRef}
      action={handleSubmit}
      className="rounded-xl ring-1 ring-border bg-muted/30 p-4 flex flex-col gap-3 w-full max-w-sm"
    >
      <p className="text-sm font-medium">Add Objective</p>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="obj-title">Title</Label>
        <Input
          id="obj-title"
          name="title"
          placeholder="Grow user engagement"
          autoFocus
          required
          disabled={isPending}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="obj-description">Description (optional)</Label>
        <Textarea
          id="obj-description"
          name="description"
          placeholder="What does success look like?"
          rows={3}
          disabled={isPending}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="obj-owner">Owner (optional)</Label>
        <Input
          id="obj-owner"
          name="owner"
          placeholder="e.g. Product team"
          disabled={isPending}
        />
      </div>

      {squads.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="obj-squad">Squad (optional)</Label>
          <Combobox
            items={[
              { value: "__none__", label: "No squad" },
              ...squads.map((s) => ({
                value: s.id,
                label: s.name,
                render: (
                  <span className="flex items-center gap-1.5">
                    <span
                      className="w-2 h-2 rounded-full shrink-0 inline-block"
                      style={{ backgroundColor: s.color }}
                    />
                    {s.name}
                  </span>
                ),
              })),
            ]}
            value={squadId ?? "__none__"}
            onValueChange={(v) => setSquadId(v === "__none__" ? null : v)}
            disabled={isPending}
          >
            <ComboboxTrigger id="obj-squad">
              <ComboboxValue placeholder="No squad" />
            </ComboboxTrigger>
            <ComboboxContent />
          </Combobox>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? "Adding…" : "Add objective"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isPending}
          onClick={() => {
            setOpen(false);
            setError(null);
            setSquadId(null);
            formRef.current?.reset();
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
