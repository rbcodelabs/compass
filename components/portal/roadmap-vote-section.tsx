"use client";

import { useState, useEffect } from "react";
import { ThumbsUp } from "lucide-react";

type RoadmapItem = {
  id: string;
  title: string;
  description: string | null;
  horizon: string;
  _count: { votes: number };
};

interface Props {
  item: RoadmapItem;
  orgSlug: string;
  workspaceSlug: string;
}

const VOTE_FORM_STORAGE_KEY = (orgSlug: string, workspaceSlug: string) =>
  `${orgSlug}-${workspaceSlug}-votes`;

function getVotedItems(orgSlug: string, workspaceSlug: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(VOTE_FORM_STORAGE_KEY(orgSlug, workspaceSlug));
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function recordVote(orgSlug: string, workspaceSlug: string, itemId: string) {
  const existing = getVotedItems(orgSlug, workspaceSlug);
  existing.add(itemId);
  localStorage.setItem(
    VOTE_FORM_STORAGE_KEY(orgSlug, workspaceSlug),
    JSON.stringify(Array.from(existing))
  );
}

export function RoadmapVoteSection({ item, orgSlug, workspaceSlug }: Props) {
  const [hasVoted, setHasVoted] = useState(false);
  const [voteCount, setVoteCount] = useState(item._count.votes);
  const [showForm, setShowForm] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [voterName, setVoterName] = useState("");
  const [voterEmail, setVoterEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHasVoted(getVotedItems(orgSlug, workspaceSlug).has(item.id));
  }, [item.id, orgSlug, workspaceSlug]);

  async function handleVote(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const res = await fetch(`/api/portal/${orgSlug}/${workspaceSlug}/vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "roadmap",
          itemId: item.id,
          voterEmail: voterEmail.trim(),
          voterName: voterName.trim() || undefined,
        }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? "Failed to submit vote");
        return;
      }

      const data = (await res.json()) as { voteCount: number };
      setVoteCount(data.voteCount);
      setHasVoted(true);
      setShowForm(false);
      recordVote(orgSlug, workspaceSlug, item.id);
    } catch {
      setError("Network error — please try again");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div
      className="rounded-xl border border-slate-200 bg-white p-3.5 flex flex-col gap-2"
      onMouseEnter={() => setIsExpanded(true)}
      onMouseLeave={() => setIsExpanded(false)}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-slate-800 leading-snug flex-1">{item.title}</p>
        {hasVoted ? (
          <div className="flex items-center gap-1 rounded-full bg-indigo-50 border border-indigo-200 px-2 py-0.5 text-xs text-indigo-600 shrink-0">
            <ThumbsUp className="w-3 h-3" />
            <span>{voteCount}</span>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            className="flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-100 hover:border-slate-300 transition-colors shrink-0"
          >
            <ThumbsUp className="w-3 h-3" />
            <span>{voteCount}</span>
          </button>
        )}
      </div>

      {item.description && (
        <p className={`text-xs text-slate-500 leading-relaxed transition-all duration-200 ${!isExpanded ? "line-clamp-2" : ""}`}>{item.description}</p>
      )}

      {!hasVoted && showForm && (
        <form onSubmit={handleVote} className="flex flex-col gap-2 pt-1 border-t border-slate-100">
          <input
            type="text"
            placeholder="Your name (optional)"
            value={voterName}
            onChange={(e) => setVoterName(e.target.value)}
            className="text-xs rounded-lg border border-slate-200 px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400"
          />
          <input
            type="email"
            placeholder="Your email (required)"
            value={voterEmail}
            onChange={(e) => setVoterEmail(e.target.value)}
            required
            className="text-xs rounded-lg border border-slate-200 px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400"
          />
          {error && <p className="text-xs text-red-500">{error}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex-1 text-xs rounded-lg bg-indigo-600 text-white px-3 py-1.5 hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {isSubmitting ? "Voting..." : "Vote"}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="text-xs rounded-lg border border-slate-200 px-3 py-1.5 hover:bg-slate-50 transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
