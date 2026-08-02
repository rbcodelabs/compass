"use client";

import { useState, useTransition } from "react";
import { ThumbsUp, Link2, ChevronDown, Bug, Lightbulb, Rocket } from "lucide-react";
import {
  updateFeedbackStatus,
  linkFeedbackToOpportunity,
  updateFeedbackType,
} from "@/app/[orgSlug]/[workspaceSlug]/feedback/actions";
import { promoteFeedbackToRoadmap } from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions";
import { FeedbackAttachments, type FeedbackAttachmentData } from "@/components/feedback/feedback-attachments";
import { CreateFeedbackDialog } from "@/components/feedback/create-feedback-dialog";
import { usePanelContext } from "@/components/panels/panel-context";
import type { CreatedFeedbackItem } from "@/app/[orgSlug]/[workspaceSlug]/feedback/actions";
import { HORIZON_META, PROMOTE_TARGET_HORIZONS } from "@/lib/roadmap";
import type { FeedbackType, Horizon } from "@/lib/types";

type FeedbackItem = {
  id: string;
  title: string;
  description: string | null;
  submitterName: string | null;
  submitterEmail: string | null;
  status: string;
  voteCount: number;
  type: FeedbackType;
  opportunityId: string | null;
  roadmapItem: { id: string; title: string; horizon: string } | null;
  createdAt: string;
  attachments: FeedbackAttachmentData[];
};

type OpportunityOption = {
  id: string;
  title: string;
};

interface Props {
  orgSlug: string;
  workspaceSlug: string;
  workspaceId: string;
  initialItems: FeedbackItem[];
  opportunities: OpportunityOption[];
}

const ALL_STATUSES = [
  "OPEN",
  "UNDER_REVIEW",
  "PLANNED",
  "IN_PROGRESS",
  "COMPLETED",
  "DECLINED",
] as const;

const STATUS_LABELS: Record<string, string> = {
  OPEN: "Open",
  UNDER_REVIEW: "Under review",
  PLANNED: "Planned",
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
  DECLINED: "Declined",
};

const STATUS_COLORS: Record<string, string> = {
  OPEN: "bg-slate-100 text-slate-600",
  UNDER_REVIEW: "bg-yellow-50 text-yellow-700",
  PLANNED: "bg-blue-50 text-blue-700",
  IN_PROGRESS: "bg-indigo-50 text-indigo-700",
  COMPLETED: "bg-green-50 text-green-700",
  DECLINED: "bg-red-50 text-red-600",
};

const TYPE_LABELS: Record<FeedbackType, string> = {
  BUG: "Bug",
  IDEA: "Idea",
};

const TYPE_COLORS: Record<FeedbackType, string> = {
  BUG: "bg-red-50 text-red-600",
  IDEA: "bg-violet-50 text-violet-600",
};

const ALL_TYPES: FeedbackType[] = ["IDEA", "BUG"];

// Promote targets exclude the launch horizons (those need a tier + checklist).
const ALL_HORIZONS: Horizon[] = PROMOTE_TARGET_HORIZONS;

// Labels for every horizon so an already-promoted item that's in LAUNCHING/
// LAUNCHED still renders a name.
const HORIZON_LABELS: Record<Horizon, string> = Object.fromEntries(
  Object.entries(HORIZON_META).map(([h, m]) => [h, m.label])
) as Record<Horizon, string>;

type TypeFilter = "ALL" | FeedbackType;

export function InternalFeedbackBoard({
  orgSlug,
  workspaceSlug,
  workspaceId,
  initialItems,
  opportunities,
}: Props) {
  const { openPanel } = usePanelContext();
  const [items, setItems] = useState(initialItems);
  const [isPending, startTransition] = useTransition();
  const [linkPickerOpen, setLinkPickerOpen] = useState<string | null>(null);
  const [statusPickerOpen, setStatusPickerOpen] = useState<string | null>(null);
  const [typePickerOpen, setTypePickerOpen] = useState<string | null>(null);
  const [promotePickerOpen, setPromotePickerOpen] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("ALL");

  const revalidatePath = `/${orgSlug}/${workspaceSlug}/feedback`;
  const roadmapRevalidatePath = `/${orgSlug}/${workspaceSlug}/roadmap`;

  function handleStatusChange(itemId: string, status: string) {
    setItems((prev) =>
      prev.map((i) => (i.id === itemId ? { ...i, status } : i))
    );
    setStatusPickerOpen(null);
    startTransition(async () => {
      await updateFeedbackStatus(itemId, status, revalidatePath);
    });
  }

  function handleLinkOpportunity(itemId: string, opportunityId: string | null) {
    setItems((prev) =>
      prev.map((i) => (i.id === itemId ? { ...i, opportunityId } : i))
    );
    setLinkPickerOpen(null);
    startTransition(async () => {
      await linkFeedbackToOpportunity(itemId, opportunityId, revalidatePath);
    });
  }

  function handleTypeChange(itemId: string, type: FeedbackType) {
    setItems((prev) =>
      prev.map((i) => (i.id === itemId ? { ...i, type } : i))
    );
    setTypePickerOpen(null);
    startTransition(async () => {
      await updateFeedbackType(itemId, type, revalidatePath);
    });
  }

  function handleCreated(item: CreatedFeedbackItem) {
    setItems((prev) => [{ ...item, roadmapItem: null, attachments: [] }, ...prev]);
  }

  function handlePromote(itemId: string, horizon: Horizon) {
    setPromotePickerOpen(null);
    startTransition(async () => {
      const roadmapItem = await promoteFeedbackToRoadmap(
        itemId,
        workspaceId,
        horizon,
        roadmapRevalidatePath
      );
      setItems((prev) =>
        prev.map((i) =>
          i.id === itemId
            ? { ...i, roadmapItem: { id: roadmapItem.id, title: roadmapItem.title, horizon } }
            : i
        )
      );
    });
  }

  const visibleItems = items.filter(
    (item) => typeFilter === "ALL" || item.type === typeFilter
  );

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
        <p className="text-sm text-slate-500">No feedback submitted yet.</p>
        <p className="text-xs text-slate-400">
          Enable the public feedback portal in Settings to start collecting submissions,
          or log one yourself below.
        </p>
        <CreateFeedbackDialog
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          revalidatePathStr={revalidatePath}
          onCreated={handleCreated}
          variant="empty-state"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" aria-busy={isPending}>
      {/* Type filter tabs + New Feedback trigger */}
      <div className="flex items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-slate-200 p-0.5 self-start">
          {(["ALL", "IDEA", "BUG"] as const).map((filter) => (
            <button
              key={filter}
              type="button"
              onClick={() => setTypeFilter(filter)}
              className={[
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                typeFilter === filter
                  ? "bg-slate-100 text-slate-800"
                  : "text-slate-500 hover:text-slate-700",
              ].join(" ")}
            >
              {filter === "BUG" && <Bug className="w-3.5 h-3.5" />}
              {filter === "IDEA" && <Lightbulb className="w-3.5 h-3.5" />}
              {filter === "ALL" ? "All" : filter === "BUG" ? "Bugs" : "Ideas"}
            </button>
          ))}
        </div>
        <CreateFeedbackDialog
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          revalidatePathStr={revalidatePath}
          onCreated={handleCreated}
        />
      </div>

      {/* Header row */}
      <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-4 px-4 py-2 text-xs font-medium text-slate-500 border-b border-slate-200">
        <span>Feedback</span>
        <span className="w-24 text-center">Type</span>
        <span className="w-20 text-center">Votes</span>
        <span className="w-32 text-center">Status</span>
        <span className="w-40 text-center">Action</span>
      </div>

      {visibleItems.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-sm text-slate-500">No {typeFilter === "BUG" ? "bugs" : "ideas"} match this filter.</p>
        </div>
      )}

      {visibleItems.map((item) => {
        const linkedOpp = opportunities.find((o) => o.id === item.opportunityId);

        return (
          <div
            key={item.id}
            className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-4 items-start rounded-xl border border-slate-200 bg-white px-4 py-3.5 hover:border-slate-300 transition-colors"
          >
            {/* Title + meta */}
            <div className="flex flex-col gap-0.5 min-w-0">
              <button
                type="button"
                onClick={() => openPanel("feedback", item.id)}
                className="text-left text-sm font-medium text-slate-800 hover:underline underline-offset-2 w-fit max-w-full truncate"
              >
                {item.title}
              </button>
              {item.description && (
                <p className="text-xs text-slate-500 line-clamp-1">{item.description}</p>
              )}
              <FeedbackAttachments attachments={item.attachments} />
              <div className="flex items-center gap-2 mt-0.5">
                {item.submitterName && (
                  <span className="text-xs text-slate-400">{item.submitterName}</span>
                )}
                {item.submitterEmail && (
                  <span className="text-xs text-slate-400">{item.submitterEmail}</span>
                )}
                <span className="text-xs text-slate-400">
                  {new Date(item.createdAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </span>
              </div>
            </div>

            {/* Type picker */}
            <div className="w-24 relative">
              <button
                type="button"
                onClick={() =>
                  setTypePickerOpen((prev) => (prev === item.id ? null : item.id))
                }
                className={[
                  "w-full flex items-center justify-between gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                  TYPE_COLORS[item.type] ?? "bg-slate-100 text-slate-600",
                ].join(" ")}
              >
                <span className="flex items-center gap-1">
                  {item.type === "BUG" ? <Bug className="w-3 h-3" /> : <Lightbulb className="w-3 h-3" />}
                  {TYPE_LABELS[item.type] ?? item.type}
                </span>
                <ChevronDown className="w-3 h-3 shrink-0" />
              </button>
              {typePickerOpen === item.id && (
                <div className="absolute top-full mt-1 left-0 z-20 rounded-xl border border-slate-200 bg-white shadow-lg py-1 w-32">
                  {ALL_TYPES.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => handleTypeChange(item.id, t)}
                      className="w-full flex items-center gap-1.5 text-left px-3 py-1.5 text-xs hover:bg-slate-50 transition-colors"
                    >
                      {t === "BUG" ? <Bug className="w-3 h-3" /> : <Lightbulb className="w-3 h-3" />}
                      {TYPE_LABELS[t]}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Vote count */}
            <div className="w-20 flex items-center justify-center pt-0.5">
              <div className="flex items-center gap-1 text-sm font-semibold text-slate-600">
                <ThumbsUp className="w-3.5 h-3.5 text-slate-400" />
                {item.voteCount}
              </div>
            </div>

            {/* Status picker */}
            <div className="w-32 relative">
              <button
                type="button"
                onClick={() =>
                  setStatusPickerOpen((prev) => (prev === item.id ? null : item.id))
                }
                className={[
                  "w-full flex items-center justify-between gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                  STATUS_COLORS[item.status] ?? "bg-slate-100 text-slate-600",
                ].join(" ")}
              >
                <span>{STATUS_LABELS[item.status] ?? item.status}</span>
                <ChevronDown className="w-3 h-3 shrink-0" />
              </button>
              {statusPickerOpen === item.id && (
                <div className="absolute top-full mt-1 left-0 z-20 rounded-xl border border-slate-200 bg-white shadow-lg py-1 w-40">
                  {ALL_STATUSES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => handleStatusChange(item.id, s)}
                      className="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 transition-colors"
                    >
                      {STATUS_LABELS[s]}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Action column: bugs promote directly to roadmap, ideas link to an opportunity */}
            <div className="w-40 relative">
              {item.type === "BUG" ? (
                item.roadmapItem ? (
                  <div className="w-full flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs text-emerald-700">
                    <Rocket className="w-3 h-3 shrink-0" />
                    <span className="truncate flex-1 text-left">
                      On roadmap ({HORIZON_LABELS[item.roadmapItem.horizon as Horizon] ?? item.roadmapItem.horizon})
                    </span>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        setPromotePickerOpen((prev) => (prev === item.id ? null : item.id))
                      }
                      className="w-full flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50 hover:border-slate-300 transition-colors"
                    >
                      <Rocket className="w-3 h-3 shrink-0 text-slate-400" />
                      <span className="truncate flex-1 text-left">Promote to roadmap</span>
                      <ChevronDown className="w-3 h-3 shrink-0 text-slate-400" />
                    </button>
                    {promotePickerOpen === item.id && (
                      <div className="absolute top-full mt-1 right-0 z-20 rounded-xl border border-slate-200 bg-white shadow-lg py-1 w-40">
                        {ALL_HORIZONS.map((h) => (
                          <button
                            key={h}
                            type="button"
                            onClick={() => handlePromote(item.id, h)}
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 transition-colors"
                          >
                            {HORIZON_LABELS[h]}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      setLinkPickerOpen((prev) => (prev === item.id ? null : item.id))
                    }
                    className="w-full flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50 hover:border-slate-300 transition-colors"
                  >
                    <Link2 className="w-3 h-3 shrink-0 text-slate-400" />
                    <span className="truncate flex-1 text-left">
                      {linkedOpp ? linkedOpp.title : "Link opportunity"}
                    </span>
                    <ChevronDown className="w-3 h-3 shrink-0 text-slate-400" />
                  </button>
                  {linkPickerOpen === item.id && (
                    <div className="absolute top-full mt-1 right-0 z-20 rounded-xl border border-slate-200 bg-white shadow-lg py-1 w-56">
                      <button
                        type="button"
                        onClick={() => handleLinkOpportunity(item.id, null)}
                        className="w-full text-left px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-50 transition-colors italic"
                      >
                        No link
                      </button>
                      {opportunities.map((opp) => (
                        <button
                          key={opp.id}
                          type="button"
                          onClick={() => handleLinkOpportunity(item.id, opp.id)}
                          className="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 transition-colors truncate"
                        >
                          {opp.title}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
