"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { unlinkTask } from "@/app/[orgSlug]/[workspaceSlug]/tasks/actions";
import { usePanelContext, type EntityPanelType } from "@/components/panels/panel-context";
import { LinkTaskDialog, type LinkableTargets } from "./link-task-dialog";
import type { TaskLinkData, TaskLinkedType } from "@/lib/types";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import { linkedTypeLabels } from "./linked-type-labels";

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

function isOriginLink(link: TaskLinkData): boolean {
  return Boolean(link.isOrigin || link.linkedType === "COMMENT" || link.linkedType === "AGENT_CONVERSATION");
}

function resolveOriginHref(link: TaskLinkData, orgSlug: string, workspaceSlug: string): string | null {
  if (link.linkedType === "AGENT_CONVERSATION") {
    return `/${orgSlug}/${workspaceSlug}/agent?c=${encodeURIComponent(link.linkedId)}`;
  }
  if (link.linkedType === "COMMENT" && link.linkedHref) {
    return link.linkedHref.startsWith("/") ? link.linkedHref : `/${orgSlug}/${workspaceSlug}/${link.linkedHref}`;
  }
  return null;
}

type Props = {
  taskId: string;
  initialLinks: TaskLinkData[];
  revalidatePathStr: string;
  linkableTargets: LinkableTargets;
  orgSlug: string;
  workspaceSlug: string;
};

export function TaskLinksPanel({ taskId, initialLinks, revalidatePathStr, linkableTargets, orgSlug, workspaceSlug }: Props) {
  const typeLabels = linkedTypeLabels(useLabels());
  const [links, setLinks] = useState(initialLinks);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const { openPanel } = usePanelContext();

  const originLinks = links.filter(isOriginLink);
  const referenceLinks = links.filter((link) => !isOriginLink(link));

  function handleUnlink(linkId: string) {
    setLinks((prev) => prev.filter((l) => l.id !== linkId));
    startTransition(async () => {
      await unlinkTask(linkId, revalidatePathStr);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {links.length === 0 && (
        <p className="text-sm text-muted-foreground">No links yet.</p>
      )}

      {originLinks.length > 0 && (
        <div data-testid="task-origin-links" className="rounded-xl border border-border bg-muted/30 overflow-hidden">
          <div className="px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground border-b border-border">
            Created from
          </div>
          {originLinks.map((link, i) => {
            const href = resolveOriginHref(link, orgSlug, workspaceSlug);
            const badge = link.linkedType === "COMMENT" ? "Comment" : "Conversation";
            return (
              <div
                key={link.id}
                className={`flex items-center gap-2 min-w-0 px-4 py-2.5 ${i > 0 ? "border-t border-border" : ""}`}
              >
                <span className="text-xs bg-muted rounded px-1.5 py-0.5 text-muted-foreground shrink-0">
                  {badge}
                </span>
                {href ? (
                  <Link
                    href={href}
                    title={link.linkedTitle}
                    className="text-sm truncate hover:underline underline-offset-2"
                  >
                    {link.linkedTitle}
                  </Link>
                ) : (
                  <span title={link.linkedTitle} className="text-sm truncate text-muted-foreground">
                    {link.linkedTitle}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {referenceLinks.length > 0 && (
        <div className="rounded-xl border border-border overflow-hidden">
          {referenceLinks.map((link, i) => {
            const linkedType = link.linkedType as TaskLinkedType;
            const panelType = TASK_LINK_TO_PANEL_TYPE[linkedType];
            return (
              <div
                key={link.id}
                className={`flex items-center justify-between gap-3 px-4 py-2.5 ${i > 0 ? "border-t border-border" : ""}`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs bg-muted rounded px-1.5 py-0.5 text-muted-foreground shrink-0">
                    {typeLabels[linkedType]}
                  </span>
                  {linkedType === "DOC" ? (
                    <Link
                      href={`/${orgSlug}/${workspaceSlug}/docs/${link.linkedId}`}
                      className="text-sm truncate hover:underline underline-offset-2"
                    >
                      {link.linkedTitle}
                    </Link>
                  ) : linkedType === "DECISION" ? (
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
        onLinked={(link) => setLinks((prev) => {
          const duplicateIndex = prev.findIndex((existing) =>
            existing.id === link.id ||
            (existing.linkedType === link.linkedType && existing.linkedId === link.linkedId)
          );
          if (duplicateIndex === -1) return [...prev, link];
          return prev.map((existing, index) => index === duplicateIndex ? link : existing);
        })}
      />
    </div>
  );
}
