"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon, TrashIcon, PencilIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createSharedFieldOptionSet,
  updateSharedFieldOptionSet,
  deleteSharedFieldOptionSet,
} from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";
import { optionsFromCommaList } from "@/lib/shared-field-options";
import type { CustomFieldObjectType, SharedFieldOptionSetData } from "@/lib/types";

const OBJECT_TYPE_LABELS: Record<CustomFieldObjectType, string> = {
  OPPORTUNITY: "Opportunity",
  SOLUTION: "Solution",
  EXPERIMENT: "Experiment",
  OBJECTIVE: "Objective",
  KEY_RESULT: "Key Result",
  ROADMAP_ITEM: "Roadmap Item",
  TASK: "Task",
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong";
}

function OptionChips({ options }: { options: SharedFieldOptionSetData["options"] }) {
  if (options.length === 0) {
    return <span className="text-xs text-muted-foreground/70 italic">No options yet</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {options.map((option) => (
        <span
          key={option.value}
          className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium"
          style={option.color ? { backgroundColor: option.color, color: "#fff" } : undefined}
        >
          {option.label}
        </span>
      ))}
    </span>
  );
}

function SetRow({
  orgSlug,
  workspaceSlug,
  set,
}: {
  orgSlug: string;
  workspaceSlug: string;
  set: SharedFieldOptionSetData;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(set.name);
  const [optionText, setOptionText] = useState(set.options.map((o) => o.label).join(", "));
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        await updateSharedFieldOptionSet(orgSlug, workspaceSlug, set.id, {
          name,
          options: optionsFromCommaList(optionText),
        });
        setEditing(false);
        router.refresh();
      } catch (caught) {
        setError(errorMessage(caught));
      }
    });
  }

  function remove() {
    setError(null);
    startTransition(async () => {
      try {
        // The delete guard reports "N fields use this" as a returned value —
        // a thrown message would be redacted by Next.js in a production build.
        const result = await deleteSharedFieldOptionSet(orgSlug, workspaceSlug, set.id);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        router.refresh();
      } catch (caught) {
        setError(errorMessage(caught));
      }
    });
  }

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      {editing ? (
        <form onSubmit={save} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`set-name-${set.id}`}>Name</Label>
            <Input
              id={`set-name-${set.id}`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={isPending}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`set-options-${set.id}`}>Options (comma-separated)</Label>
            <Input
              id={`set-options-${set.id}`}
              value={optionText}
              onChange={(event) => setOptionText(event.target.value)}
              placeholder="e.g. Payments, Billing, Growth"
              disabled={isPending}
            />
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={isPending}>
              {isPending ? "Saving..." : "Save"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isPending}
              onClick={() => {
                setEditing(false);
                setName(set.name);
                setOptionText(set.options.map((o) => o.label).join(", "));
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="text-sm font-medium">{set.name}</span>
              <OptionChips options={set.options} />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                onClick={() => setEditing(true)}
                disabled={isPending}
                className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                aria-label={`Edit ${set.name}`}
              >
                <PencilIcon className="size-4" />
              </button>
              <button
                onClick={remove}
                disabled={isPending}
                className="text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                aria-label={`Delete ${set.name}`}
              >
                <TrashIcon className="size-4" />
              </button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {set.fieldCount === 0
              ? "Not used by any field yet."
              : `Used by ${set.fieldCount} ${set.fieldCount === 1 ? "field" : "fields"}: ${set.usedBy
                  .map((field) => `${OBJECT_TYPE_LABELS[field.objectType]} → ${field.name}`)
                  .join(", ")}`}
          </p>
        </>
      )}

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function AddSetForm({ orgSlug, workspaceSlug }: { orgSlug: string; workspaceSlug: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [optionText, setOptionText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        await createSharedFieldOptionSet(orgSlug, workspaceSlug, {
          name,
          options: optionsFromCommaList(optionText),
        });
        setOpen(false);
        setName("");
        setOptionText("");
        router.refresh();
      } catch (caught) {
        setError(errorMessage(caught));
      }
    });
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-1.5 rounded-lg border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground"
      >
        <PlusIcon className="size-3.5" />
        Add shared option set
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-xl bg-muted/30 p-4 ring-1 ring-border">
      <p className="text-sm font-medium">New shared option set</p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-set-name">Name</Label>
        <Input
          id="new-set-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Product Area"
          autoFocus
          required
          disabled={isPending}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-set-options">Options (comma-separated)</Label>
        <Input
          id="new-set-options"
          value={optionText}
          onChange={(event) => setOptionText(event.target.value)}
          placeholder="e.g. Payments, Billing, Growth"
          disabled={isPending}
        />
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? "Creating..." : "Create set"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isPending}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function SharedOptionSetsPanel({
  orgSlug,
  workspaceSlug,
  sets,
}: {
  orgSlug: string;
  workspaceSlug: string;
  sets: SharedFieldOptionSetData[];
}) {
  return (
    <div className="flex flex-col gap-3">
      {sets.length > 0 ? (
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {sets.map((set) => (
            <SetRow key={set.id} orgSlug={orgSlug} workspaceSlug={workspaceSlug} set={set} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No shared option sets yet. Create one to reuse a single picklist — a Product Area, a
          component, a tier — across select fields on more than one object type.
        </p>
      )}

      <AddSetForm orgSlug={orgSlug} workspaceSlug={workspaceSlug} />
    </div>
  );
}
