"use client";

import { useState, useTransition } from "react";
import { ThumbsUp, Link2, ChevronDown } from "lucide-react";
import { updateFeedbackStatus, linkFeedbackToOpportunity } from "@/app/[orgSlug]/[workspaceSlug]/feedback/actions";

type FeedbackItem = {
  id: string;
  title: string;
  description: string | null;
  submitterName: string | null;
  submitterEmail: string | null;
  status: string;
  voteCount: number;
  opportunityId: string | null;
  createdAt: string;
};

type OpportunityOption = {
  id: string;
  title: string;
};

interface Props {
  orgSlug: string;
  workspaceSlug: string;
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

export function InternalFeedbackBoard({
  orgSlug,
  workspaceSlug,
  initialItems,
  opportunities,
}: Props) {
  const [items, setItems] = useState(initialItems);
  const [isPending, startTransition] = useTransition();
  const [linkPickerOpen, setLinkPickerOpen] = useState<string | null>(null);
  const [statusPickerOpen, setStatusPickerOpen] = useState<string | null>(null);

  const revalidatePath = `/${orgSlug}/${workspaceSlug}/feedback`;

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

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <p className="text-sm text-slate-500">No feedback submitted yet.</p>
        <p className="text-xs text-slate-400 mt-1">
          Enable the public feedback portal in Settings to start collecting submissions.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" aria-busy={isPending}>
      {/* Header row */}
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-4 px-4 py-2 text-xs font-medium text-slate-500 border-b border-slate-200">
        <span>Feedback</span>
        <span className="w-20 text-center">Votes</span>
        <span className="w-32 text-center">Status</span>
        <span className="w-36 text-center">Opportunity</span>
      </div>

      {items.map((item) => {
        const linkedOpp = opportunities.find((o) => o.id === item.opportunityId);

        return (
          <div
            key={item.id}
            className="grid grid-cols-[1fr_auto_auto_auto] gap-4 items-start rounded-xl border border-slate-200 bg-white px-4 py-3.5 hover:border-slate-300 transition-colors"
          >
            {/* Title + meta */}
            <div className="flex flex-col gap-0.5 min-w-0">
              <p className="text-sm font-medium text-slate-800">{item.title}</p>
              {item.description && (
                <p className="text-xs text-slate-500 line-clamp-1">{item.description}</p>
              )}
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

            {/* Opportunity link picker */}
            <div className="w-36 relative">
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
            </div>
          </div>
        );
      })}
    </div>
  );
}
