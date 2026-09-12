"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { unlinkTask } from "@/app/[orgSlug]/[workspaceSlug]/tasks/actions";
import { usePanelContext, type EntityPanelType } from "@/components/panels/panel-context";
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
  DECISION: "Decision",
};

// DOC and DECISION have no corresponding entity-detail panel — they navigate
// to the doc page / review page instead. `assumption` is a valid panel type
// but has no TaskLinkedType counterpart, so it's intentionally absent from
// this map.
const TASK_LINK_TO_PANEL_TYPE: Partial<Record<TaskLinkedType, EntityPanelType>> = {
  OPPORTUNITY: "opportunity",
  SOLUTION: "solution",
  ROADMAP_ITEM: "roadmapItem",
  OBJECTIVE: "objective",
  KEY_RESULT: "keyResult",
  EXPERIMENT: "experiment",
  FEEDBACK_ITEM: "feedback",
};

type Props = {
  taskId: string;
  initialLinks: TaskLinkData[];
  revalidatePathStr: string;
  linkableTargets: LinkableTargets;
  orgSlug: string;
  workspaceSlug: string;
};

export function TaskLinksPanel({ taskId, initialLinks, revalidatePathStr, linkableTargets, orgSlug, workspaceSlug }: Props) {
  const [links, setLinks] = useState(initialLinks);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const { openPanel } = usePanelContext();

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
          {links.map((link, i) => {
            const panelType = TASK_LINK_TO_PANEL_TYPE[link.linkedType];
            return (
              <div
                key={link.id}
                className={`flex items-center justify-between gap-3 px-4 py-2.5 ${i > 0 ? "border-t border-border" : ""}`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs bg-muted rounded px-1.5 py-0.5 text-muted-foreground shrink-0">
                    {LINKED_TYPE_LABELS[link.linkedType]}
                  </span>
                  {link.linkedType === "DOC" ? (
                    <Link
                      href={`/${orgSlug}/${workspaceSlug}/docs/${link.linkedId}`}
                      className="text-sm truncate hover:underline underline-offset-2"
                    >
                      {link.linkedTitle}
                    </Link>
                  ) : link.linkedType === "DECISION" ? (
                    <Link
                      href={`/${orgSlug}/${workspaceSlug}/reviews/${link.linkedId}`}
                      className="text-sm truncate hover:underline underline-offset-2"
                    >
                      {link.linkedTitle}
                    </Link>
                  ) : panelType ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openPanel(panelType, link.linkedId);
                      }}
                      className="text-sm truncate text-left hover:underline underline-offset-2"
                    >
                      {link.linkedTitle}
                    </button>
                  ) : (
                    <span className="text-sm truncate">{link.linkedTitle}</span>
                  )}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleUnlink(link.id);
                  }}
                  disabled={isPending}
                  className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50 shrink-0"
                  aria-label={`Unlink ${link.linkedTitle}`}
                >
                  <XIcon className="size-4" />
                </button>
              </div>
            );
          })}
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
