"use client";

import { useState, useTransition } from "react";
import { updatePortalSettings } from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";
import { ExternalLink } from "lucide-react";

interface Props {
  orgSlug: string;
  workspaceSlug: string;
  feedbackEnabled: boolean;
  roadmapPublic: boolean;
}

export function PortalSettingsPanel({
  orgSlug,
  workspaceSlug,
  feedbackEnabled: initialFeedback,
  roadmapPublic: initialRoadmap,
}: Props) {
  const [feedbackEnabled, setFeedbackEnabled] = useState(initialFeedback);
  const [roadmapPublic, setRoadmapPublic] = useState(initialRoadmap);
  const [isPending, startTransition] = useTransition();

  const base = typeof window !== "undefined" ? window.location.origin : "";
  const roadmapUrl = `/portal/${orgSlug}/${workspaceSlug}/roadmap`;
  const feedbackUrl = `/portal/${orgSlug}/${workspaceSlug}/feedback`;

  function handleToggle(field: "feedbackEnabled" | "roadmapPublic", value: boolean) {
    if (field === "feedbackEnabled") setFeedbackEnabled(value);
    else setRoadmapPublic(value);

    startTransition(async () => {
      await updatePortalSettings(orgSlug, workspaceSlug, {
        ...(field === "feedbackEnabled" ? { feedbackEnabled: value } : {}),
        ...(field === "roadmapPublic" ? { roadmapPublic: value } : {}),
      });
    });
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Roadmap toggle */}
      <div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3.5">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Public roadmap</span>
          <span className="text-xs text-muted-foreground">
            Anyone with the link can view the roadmap and vote on items.
          </span>
          {roadmapPublic && (
            <a
              href={roadmapUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 flex items-center gap-1 text-xs text-indigo-600 hover:underline"
            >
              {roadmapUrl}
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={roadmapPublic}
          disabled={isPending}
          onClick={() => handleToggle("roadmapPublic", !roadmapPublic)}
          className={[
            "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            roadmapPublic ? "bg-indigo-600" : "bg-slate-200",
          ].join(" ")}
        >
          <span
            className={[
              "pointer-events-none block h-4 w-4 rounded-full bg-white shadow-md ring-0 transition-transform",
              roadmapPublic ? "translate-x-4" : "translate-x-0",
            ].join(" ")}
          />
        </button>
      </div>

      {/* Feedback toggle */}
      <div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3.5">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Public feedback portal</span>
          <span className="text-xs text-muted-foreground">
            Anyone with the link can submit feedback and vote on existing items.
          </span>
          {feedbackEnabled && (
            <a
              href={feedbackUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 flex items-center gap-1 text-xs text-indigo-600 hover:underline"
            >
              {feedbackUrl}
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={feedbackEnabled}
          disabled={isPending}
          onClick={() => handleToggle("feedbackEnabled", !feedbackEnabled)}
          className={[
            "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            feedbackEnabled ? "bg-indigo-600" : "bg-slate-200",
          ].join(" ")}
        >
          <span
            className={[
              "pointer-events-none block h-4 w-4 rounded-full bg-white shadow-md ring-0 transition-transform",
              feedbackEnabled ? "translate-x-4" : "translate-x-0",
            ].join(" ")}
          />
        </button>
      </div>
    </div>
  );
}
