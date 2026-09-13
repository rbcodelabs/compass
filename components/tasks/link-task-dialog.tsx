"use client";

import { useState, useTransition } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Combobox,
  ComboboxContent,
  ComboboxTrigger,
  ComboboxValue,
} from "@/components/ui/combobox";
import { linkTask } from "@/app/[orgSlug]/[workspaceSlug]/tasks/actions";
import type { TaskLinkedType, TaskLinkData } from "@/lib/types";

const LINKED_TYPE_LABELS: Record<TaskLinkedType, string> = {
  OPPORTUNITY: "Opportunity",
  SOLUTION: "Solution",
  ROADMAP_ITEM: "Roadmap Item",
  OBJECTIVE: "Objective",
  KEY_RESULT: "Key Result",
  DOC: "Doc",
  EXPERIMENT: "Experiment",
  FEEDBACK_ITEM: "Feedback Item",
  DECISION: "Decision",
};

export type LinkableTarget = { id: string; title: string };
export type LinkableTargets = Record<TaskLinkedType, LinkableTarget[]>;

type Props = {
  taskId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  revalidatePathStr: string;
  linkableTargets: LinkableTargets;
  onLinked: (link: TaskLinkData) => void;
};

const LINKED_TYPES = Object.keys(LINKED_TYPE_LABELS) as TaskLinkedType[];

export function LinkTaskDialog({ taskId, open, onOpenChange, revalidatePathStr, linkableTargets, onLinked }: Props) {
  const [linkedType, setLinkedType] = useState<TaskLinkedType>("OPPORTUNITY");
  const [linkedId, setLinkedId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const options = linkableTargets[linkedType] ?? [];

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!linkedId) return;
    const target = options.find((o) => o.id === linkedId);
    if (!target) return;

    startTransition(async () => {
      const link = await linkTask(taskId, linkedType, linkedId, revalidatePathStr);
      onLinked({ id: link.id, linkedType, linkedId, linkedTitle: target.title });
      onOpenChange(false);
      setLinkedId(null);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Link to another item</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="link-task-type">Type</Label>
            <Select
              value={linkedType}
              onValueChange={(v) => {
                setLinkedType(v as TaskLinkedType);
                setLinkedId(null);
              }}
              disabled={isPending}
            >
              <SelectTrigger id="link-task-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LINKED_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {LINKED_TYPE_LABELS[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="link-task-target">{LINKED_TYPE_LABELS[linkedType]}</Label>
            {options.length === 0 ? (
              <p className="text-xs text-muted-foreground">No {LINKED_TYPE_LABELS[linkedType].toLowerCase()}s available in this workspace.</p>
            ) : (
              <Combobox
                items={options.map((o) => ({ value: o.id, label: o.title }))}
                value={linkedId}
                onValueChange={setLinkedId}
                disabled={isPending}
              >
                <ComboboxTrigger id="link-task-target">
                  <ComboboxValue placeholder="Select…" />
                </ComboboxTrigger>
                <ComboboxContent />
              </Combobox>
            )}
          </div>

          <DialogFooter>
            <Button type="submit" size="sm" disabled={isPending || !linkedId}>
              {isPending ? "Linking..." : "Link"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
