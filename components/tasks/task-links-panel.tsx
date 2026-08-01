"use client";

import { useState, useTransition } from "react";
import { PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { unlinkTask } from "@/app/[orgSlug]/[workspaceSlug]/tasks/actions";
import { LinkTaskDialog, type LinkableTargets } from "./link-task-dialog";
import type { TaskLinkData, TaskLinkedType } from "@/lib/types";

const LINKED_TYPE_LABELS: Record<TaskLinkedType, string> = {
  OPPORTUNITY: "Opportunity",
  SOLUTION: "Solution",
  ROADMAP_ITEM: "Roadmap Item",
  OBJECTIVE: "Objective",
  KEY_RESULT: "Key Result",
  DOC: "Doc",
  EXPERIMENT: "Experiment",
  FEEDBACK_ITEM: "Feedback Item",
};

type Props = {
  taskId: string;
  initialLinks: TaskLinkData[];
  revalidatePathStr: string;
  linkableTargets: LinkableTargets;
};

export function TaskLinksPanel({ taskId, initialLinks, revalidatePathStr, linkableTargets }: Props) {
  const [links, setLinks] = useState(initialLinks);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleUnlink(linkId: string) {
    setLinks((prev) => prev.filter((l) => l.id !== linkId));
    startTransition(async () => {
      await unlinkTask(linkId, revalidatePathStr);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {links.length === 0 ? (
        <p className="text-sm text-muted-foreground">No links yet.</p>
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          {links.map((link, i) => (
            <div
              key={link.id}
              className={`flex items-center justify-between gap-3 px-4 py-2.5 ${i > 0 ? "border-t border-border" : ""}`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs bg-muted rounded px-1.5 py-0.5 text-muted-foreground shrink-0">
                  {LINKED_TYPE_LABELS[link.linkedType]}
                </span>
                <span className="text-sm truncate">{link.linkedTitle}</span>
              </div>
              <button
                onClick={() => handleUnlink(link.id)}
                disabled={isPending}
                className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50 shrink-0"
                aria-label={`Unlink ${link.linkedTitle}`}
              >
                <XIcon className="size-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setDialogOpen(true)}>
        <PlusIcon className="size-3.5" />
        Add link
      </Button>

      <LinkTaskDialog
        taskId={taskId}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        revalidatePathStr={revalidatePathStr}
        linkableTargets={linkableTargets}
        onLinked={(link) => setLinks((prev) => [...prev, link])}
      />
    </div>
  );
}
