"use client";

import { useState, useEffect } from "react";
import { ThumbsUp, MessageSquare } from "lucide-react";
import { PortalSignInGate } from "@/components/portal/portal-sign-in-gate";

type FeedbackItemData = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  voteCount: number;
  submitterName: string | null;
  createdAt: string;
};

interface Props {
  orgSlug: string;
  workspaceSlug: string;
  initialItems: FeedbackItemData[];
  portalAuthRequired: boolean;
  portalAccountEmail: string | null;
}

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

const VOTE_STORAGE_KEY = (orgSlug: string, workspaceSlug: string) =>
  `${orgSlug}-${workspaceSlug}-votes`;

function getVotedItems(orgSlug: string, workspaceSlug: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(VOTE_STORAGE_KEY(orgSlug, workspaceSlug));
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function recordVote(orgSlug: string, workspaceSlug: string, itemId: string) {
  const existing = getVotedItems(orgSlug, workspaceSlug);
  existing.add(itemId);
  localStorage.setItem(
    VOTE_STORAGE_KEY(orgSlug, workspaceSlug),
    JSON.stringify(Array.from(existing))
  );
}

export function FeedbackPortalSection({
  orgSlug,
  workspaceSlug,
  initialItems,
  portalAuthRequired,
  portalAccountEmail,
}: Props) {
  const requiresSignIn = portalAuthRequired && !portalAccountEmail;
  const [items, setItems] = useState(initialItems);
  const [votedIds, setVotedIds] = useState<Set<string>>(new Set());

  // Title form state
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [submitterName, setSubmitterName] = useState("");
  const [submitterEmail, setSubmitterEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState(false);

  // Per-item vote form state
  const [voteFormOpen, setVoteFormOpen] = useState<string | null>(null);
  const [voteEmail, setVoteEmail] = useState("");
  const [voteName, setVoteName] = useState("");
  const [voteError, setVoteError] = useState<string | null>(null);
  const [isVoting, setIsVoting] = useState(false);

  useEffect(() => {
    setVotedIds(getVotedItems(orgSlug, workspaceSlug));
  }, [orgSlug, workspaceSlug]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    setIsSubmitting(true);

    try {
      const res = await fetch(`/api/portal/${orgSlug}/${workspaceSlug}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          submitterName: submitterName.trim() || undefined,
          submitterEmail: submitterEmail.trim() || undefined,
        }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setSubmitError(data.error ?? "Failed to submit");
        return;
      }

      const newItem = (await res.json()) as {
        id: string;
        title: string;
        status: string;
        voteCount: number;
        createdAt: string;
      };

      setItems((prev) => [
        {
          id: newItem.id,
          title: newItem.title,
          description: description.trim() || null,
          status: newItem.status,
          voteCount: newItem.voteCount,
          submitterName: submitterName.trim() || null,
          createdAt: newItem.createdAt,
        },
        ...prev,
      ]);

      setTitle("");
      setDescription("");
      setSubmitterName("");
      setSubmitterEmail("");
      setSubmitSuccess(true);
      setTimeout(() => setSubmitSuccess(false), 3000);
    } catch {
      setSubmitError("Network error — please try again");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleVote(e: React.FormEvent, itemId: string) {
    e.preventDefault();
    setVoteError(null);
    setIsVoting(true);

    try {
      const res = await fetch(`/api/portal/${orgSlug}/${workspaceSlug}/vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "feedback",
          itemId,
          voterEmail: voteEmail.trim(),
          voterName: voteName.trim() || undefined,
        }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setVoteError(data.error ?? "Failed to vote");
        return;
      }

      const data = (await res.json()) as { voteCount: number };

      setItems((prev) =>
        prev.map((item) =>
          item.id === itemId ? { ...item, voteCount: data.voteCount } : item
        )
      );

      const newVoted = new Set(votedIds);
      newVoted.add(itemId);
      setVotedIds(newVoted);
      recordVote(orgSlug, workspaceSlug, itemId);
      setVoteFormOpen(null);
      setVoteEmail("");
      setVoteName("");
    } catch {
      setVoteError("Network error — please try again");
    } finally {
      setIsVoting(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Feedback</h1>
        <p className="text-sm text-slate-500 mt-1">
          Share your ideas and vote on what matters most.
        </p>
      </div>

      {/* Submission form */}
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-800 mb-4">Submit feedback</h2>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="fb-title" className="text-xs font-medium text-slate-600">
              Title <span className="text-red-500">*</span>
            </label>
            <input
              id="fb-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What would you like to see?"
              required
              maxLength={255}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="fb-description" className="text-xs font-medium text-slate-600">
              Description
            </label>
            <textarea
              id="fb-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Tell us more..."
              rows={3}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400 resize-none"
            />
          </div>
          {portalAuthRequired ? (
            requiresSignIn ? (
              <PortalSignInGate actionLabel="submit feedback" />
            ) : (
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-600">Your name</label>
                <input
                  type="text"
                  value={submitterName}
                  onChange={(e) => setSubmitterName(e.target.value)}
                  placeholder="Optional"
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
                />
                <p className="text-xs text-slate-400 mt-1">
                  Signed in as <span className="font-medium text-slate-600">{portalAccountEmail}</span>
                </p>
              </div>
            )
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label htmlFor="fb-name" className="text-xs font-medium text-slate-600">
                  Your name
                </label>
                <input
                  id="fb-name"
                  type="text"
                  value={submitterName}
                  onChange={(e) => setSubmitterName(e.target.value)}
                  placeholder="Optional"
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="fb-email" className="text-xs font-medium text-slate-600">
                  Your email
                </label>
                <input
                  id="fb-email"
                  type="email"
                  value={submitterEmail}
                  onChange={(e) => setSubmitterEmail(e.target.value)}
                  placeholder="Optional"
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
                />
              </div>
            </div>
          )}
          {submitError && <p className="text-xs text-red-500">{submitError}</p>}
          {submitSuccess && (
            <p className="text-xs text-green-600">Thank you for your feedback!</p>
          )}
          <button
            type="submit"
            disabled={isSubmitting || !title.trim() || requiresSignIn}
            className="self-start rounded-lg bg-indigo-600 text-white text-sm px-4 py-2 hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {isSubmitting ? "Submitting..." : "Submit"}
          </button>
        </form>
      </div>

      {/* Feedback list */}
      {items.length > 0 && (
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-slate-800">
            {items.length} {items.length === 1 ? "idea" : "ideas"}
          </h2>
          {items.map((item) => {
            const voted = votedIds.has(item.id);
            const isVoteOpen = voteFormOpen === item.id;

            return (
              <div
                key={item.id}
                className="rounded-xl border border-slate-200 bg-white p-4 flex gap-3"
              >
                {/* Vote column */}
                <div className="flex flex-col items-center shrink-0 pt-0.5">
                  {voted ? (
                    <div className="flex flex-col items-center gap-0.5 rounded-lg bg-indigo-50 border border-indigo-200 px-2 py-1.5">
                      <ThumbsUp className="w-3.5 h-3.5 text-indigo-600" />
                      <span className="text-xs font-semibold text-indigo-700">{item.voteCount}</span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setVoteFormOpen(isVoteOpen ? null : item.id);
                        setVoteError(null);
                        setVoteEmail("");
                        setVoteName("");
                      }}
                      className="flex flex-col items-center gap-0.5 rounded-lg border border-slate-200 px-2 py-1.5 hover:bg-slate-50 hover:border-slate-300 transition-colors"
                    >
                      <ThumbsUp className="w-3.5 h-3.5 text-slate-500" />
                      <span className="text-xs font-semibold text-slate-600">{item.voteCount}</span>
                    </button>
                  )}
                </div>

                {/* Content */}
                <div className="flex flex-col gap-1 flex-1 min-w-0">
                  <div className="flex items-start gap-2 flex-wrap">
                    <p className="text-sm font-medium text-slate-800 flex-1">{item.title}</p>
                    <span
                      className={[
                        "text-xs px-2 py-0.5 rounded-full font-medium shrink-0",
                        STATUS_COLORS[item.status] ?? "bg-slate-100 text-slate-600",
                      ].join(" ")}
                    >
                      {STATUS_LABELS[item.status] ?? item.status}
                    </span>
                  </div>
                  {item.description && (
                    <p className="text-xs text-slate-500 leading-relaxed">{item.description}</p>
                  )}
                  <div className="flex items-center gap-2 mt-0.5">
                    {item.submitterName && (
                      <span className="text-xs text-slate-400">{item.submitterName}</span>
                    )}
                    <span className="text-xs text-slate-400">
                      {new Date(item.createdAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </span>
                  </div>

                  {/* Inline vote form */}
                  {!voted && isVoteOpen && (
                    requiresSignIn ? (
                      <div className="mt-2 pt-2 border-t border-slate-100">
                        <PortalSignInGate actionLabel="vote" />
                      </div>
                    ) : (
                      <form
                        onSubmit={(e) => handleVote(e, item.id)}
                        className="mt-2 flex flex-col gap-2 pt-2 border-t border-slate-100"
                      >
                        <input
                          type="text"
                          placeholder="Your name (optional)"
                          value={voteName}
                          onChange={(e) => setVoteName(e.target.value)}
                          className="text-xs rounded-lg border border-slate-200 px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                        />
                        {portalAuthRequired ? (
                          <p className="text-xs text-slate-400 px-0.5">
                            Voting as <span className="font-medium text-slate-600">{portalAccountEmail}</span>
                          </p>
                        ) : (
                          <input
                            type="email"
                            placeholder="Your email (required)"
                            value={voteEmail}
                            onChange={(e) => setVoteEmail(e.target.value)}
                            required
                            className="text-xs rounded-lg border border-slate-200 px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                          />
                        )}
                        {voteError && <p className="text-xs text-red-500">{voteError}</p>}
                        <div className="flex gap-2">
                          <button
                            type="submit"
                            disabled={isVoting}
                            className="text-xs rounded-lg bg-indigo-600 text-white px-3 py-1.5 hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                          >
                            {isVoting ? "Voting..." : "Vote"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setVoteFormOpen(null)}
                            className="text-xs rounded-lg border border-slate-200 px-3 py-1.5 hover:bg-slate-50 transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    )
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {items.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <MessageSquare className="w-10 h-10 text-slate-300 mb-3" />
          <p className="text-sm text-slate-500">No feedback yet — be the first to share!</p>
        </div>
      )}
    </div>
  );
}
