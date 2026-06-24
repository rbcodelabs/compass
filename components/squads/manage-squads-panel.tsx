"use client";

import { useState, useTransition, useRef } from "react";
import { PlusIcon, TrashIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createSquad, deleteSquad } from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";
import type { SquadData } from "@/lib/types";

const PRESET_COLORS = [
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#06b6d4", // cyan
  "#3b82f6", // blue
];

interface Props {
  orgSlug: string;
  workspaceSlug: string;
  initialSquads: SquadData[];
}

function AddSquadForm({
  orgSlug,
  workspaceSlug,
  onAdded,
}: {
  orgSlug: string;
  workspaceSlug: string;
  onAdded: (squad: SquadData) => void;
}) {
  const [open, setOpen] = useState(false);
  const [color, setColor] = useState(PRESET_COLORS[0]);
  const [isPending, startTransition] = useTransition();
  const nameRef = useRef<HTMLInputElement>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const name = nameRef.current?.value.trim() ?? "";
    if (!name) return;

    startTransition(async () => {
      await createSquad(orgSlug, workspaceSlug, { name, color });
      // Optimistically add to list via callback — server will revalidate too
      onAdded({ id: crypto.randomUUID(), name, color });
      setOpen(false);
      setColor(PRESET_COLORS[0]);
      if (nameRef.current) nameRef.current.value = "";
    });
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 w-full rounded-lg border border-dashed border-border/60 py-2 px-3 text-xs text-muted-foreground hover:text-foreground hover:border-border transition-colors"
      >
        <PlusIcon className="w-3.5 h-3.5" />
        Add squad
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl ring-1 ring-border bg-muted/30 p-4 flex flex-col gap-3"
    >
      <p className="text-sm font-medium">New Squad</p>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="squad-name">Name</Label>
        <Input
          id="squad-name"
          ref={nameRef}
          placeholder="e.g. Growth, Platform, Mobile"
          autoFocus
          required
          disabled={isPending}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Color</Label>
        <div className="flex items-center gap-2">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className="w-6 h-6 rounded-full ring-offset-background transition-transform hover:scale-110"
              style={{
                backgroundColor: c,
                outline: color === c ? `2px solid ${c}` : "none",
                outlineOffset: "2px",
              }}
              aria-label={`Select color ${c}`}
            />
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? "Creating..." : "Create Squad"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isPending}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function ManageSquadsPanel({ orgSlug, workspaceSlug, initialSquads }: Props) {
  const [squads, setSquads] = useState(initialSquads);
  const [isPending, startTransition] = useTransition();

  function handleDelete(squadId: string) {
    startTransition(async () => {
      await deleteSquad(orgSlug, workspaceSlug, squadId);
      setSquads((prev) => prev.filter((s) => s.id !== squadId));
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {squads.length > 0 && (
        <div className="rounded-xl border border-border overflow-hidden">
          {squads.map((squad, i) => (
            <div
              key={squad.id}
              className={`flex items-center justify-between gap-3 px-4 py-2.5 ${
                i > 0 ? "border-t border-border" : ""
              }`}
            >
              <div className="flex items-center gap-2.5">
                <span
                  className="w-3 h-3 rounded-full shrink-0"
                  style={{ backgroundColor: squad.color }}
                />
                <span className="text-sm font-medium">{squad.name}</span>
              </div>
              <button
                onClick={() => handleDelete(squad.id)}
                disabled={isPending}
                className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                aria-label={`Delete ${squad.name} squad`}
              >
                <TrashIcon className="size-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {squads.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No squads yet. Create one to start assigning ownership across opportunities, experiments, and objectives.
        </p>
      )}

      <AddSquadForm
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        onAdded={(squad) => setSquads((prev) => [...prev, squad])}
      />
    </div>
  );
}
