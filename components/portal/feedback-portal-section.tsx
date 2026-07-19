"use client";

import { useState, useEffect, useRef } from "react";
import { ThumbsUp, MessageSquare, Bug, Lightbulb, File as FileIcon, Loader2, X } from "lucide-react";
import { PortalSignInGate } from "@/components/portal/portal-sign-in-gate";
import { FeedbackAttachments, type FeedbackAttachmentData } from "@/components/feedback/feedback-attachments";
import type { FeedbackType } from "@/lib/types";

type FeedbackItemData = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  voteCount: number;
  type: FeedbackType;
  submitterName: string | null;
  createdAt: string;
  attachments: FeedbackAttachmentData[];
};

const ALLOWED_ATTACHMENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
]);

const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;

type PendingAttachment = {
  clientId: string;
  file: File;
  status: "uploading" | "done" | "error";
  url?: string;
  filename?: string;
  fileType?: string;
  fileSize?: number;
  error?: string;
};

const TYPE_LABELS: Record<FeedbackType, string> = {
  BUG: "Bug",
  IDEA: "Idea",
};

const TYPE_COLORS: Record<FeedbackType, string> = {
  BUG: "bg-red-50 text-red-600",
  IDEA: "bg-violet-50 text-violet-600",
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
  const [type, setType] = useState<FeedbackType>("IDEA");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [submitterName, setSubmitterName] = useState("");
  const [submitterEmail, setSubmitterEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState(false);

  // Attachment upload state
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

  // Per-item vote form state
  const [voteFormOpen, setVoteFormOpen] = useState<string | null>(null);
  const [voteEmail, setVoteEmail] = useState("");
  const [voteName, setVoteName] = useState("");
  const [voteError, setVoteError] = useState<string | null>(null);
  const [isVoting, setIsVoting] = useState(false);

  useEffect(() => {
    setVotedIds(getVotedItems(orgSlug, workspaceSlug));
  }, [orgSlug, workspaceSlug]);

  async function uploadAttachment(clientId: string, file: File) {
    const controller = new AbortController();
    abortControllersRef.current.set(clientId, controller);

    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/portal/${orgSlug}/${workspaceSlug}/feedback/upload`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setPendingAttachments((prev) =>
          prev.map((a) =>
            a.clientId === clientId
              ? { ...a, status: "error", error: data.error ?? "Upload failed" }
              : a
          )
        );
        return;
      }

      const data = (await res.json()) as {
        url: string;
        filename: string;
        fileType: string;
        fileSize: number;
      };

      setPendingAttachments((prev) =>
        prev.map((a) =>
          a.clientId === clientId
            ? {
                ...a,
                status: "done",
                url: data.url,
                filename: data.filename,
                fileType: data.fileType,
                fileSize: data.fileSize,
              }
            : a
        )
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setPendingAttachments((prev) =>
        prev.map((a) =>
          a.clientId === clientId ? { ...a, status: "error", error: "Network error" } : a
        )
      );
    } finally {
      abortControllersRef.current.delete(clientId);
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-selecting the same file later

    if (files.length === 0) return;

    setAttachmentError(null);

    if (pendingAttachments.length + files.length > MAX_ATTACHMENTS) {
      setAttachmentError(`Maximum ${MAX_ATTACHMENTS} attachments`);
      return;
    }

    const accepted: File[] = [];
    for (const file of files) {
      if (!ALLOWED_ATTACHMENT_TYPES.has(file.type)) {
        setAttachmentError(`"${file.name}" is an unsupported file type`);
        continue;
      }
      if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
        setAttachmentError(`"${file.name}" is larger than 10MB`);
        continue;
      }
      accepted.push(file);
    }

    if (accepted.length === 0) return;

    const newEntries: PendingAttachment[] = accepted.map((file) => ({
      clientId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      status: "uploading",
    }));

    setPendingAttachments((prev) => [...prev, ...newEntries]);
    for (const entry of newEntries) {
      uploadAttachment(entry.clientId, entry.file);
    }
  }

  function handleRemoveAttachment(clientId: string) {
    const controller = abortControllersRef.current.get(clientId);
    if (controller) {
      controller.abort();
      abortControllersRef.current.delete(clientId);
    }
    setPendingAttachments((prev) => prev.filter((a) => a.clientId !== clientId));
  }

  const isUploadingAttachments = pendingAttachments.some((a) => a.status === "uploading");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    setIsSubmitting(true);

    const uploadedAttachments = pendingAttachments
      .filter((a) => a.status === "done")
      .map((a) => ({
        url: a.url!,
        filename: a.filename!,
        fileType: a.fileType!,
        fileSize: a.fileSize!,
      }));

    try {
      const res = await fetch(`/api/portal/${orgSlug}/${workspaceSlug}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          type,
          submitterName: submitterName.trim() || undefined,
          submitterEmail: submitterEmail.trim() || undefined,
          attachments: uploadedAttachments,
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
        type: FeedbackType;
        createdAt: string;
        attachments: FeedbackAttachmentData[];
      };

      setItems((prev) => [
        {
          id: newItem.id,
          title: newItem.title,
          description: description.trim() || null,
          status: newItem.status,
          voteCount: newItem.voteCount,
          type: newItem.type,
          submitterName: submitterName.trim() || null,
          createdAt: newItem.createdAt,
          attachments: newItem.attachments,
        },
        ...prev,
      ]);

      setTitle("");
      setDescription("");
      setType("IDEA");
      setSubmitterName("");
      setSubmitterEmail("");
      setPendingAttachments([]);
      setAttachmentError(null);
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
            <span className="text-xs font-medium text-slate-600">Type</span>
            <div className="inline-flex rounded-lg border border-slate-200 p-0.5 self-start">
              <button
                type="button"
                onClick={() => setType("IDEA")}
                className={[
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  type === "IDEA" ? "bg-violet-50 text-violet-700" : "text-slate-500 hover:text-slate-700",
                ].join(" ")}
              >
                <Lightbulb className="w-3.5 h-3.5" />
                Idea
              </button>
              <button
                type="button"
                onClick={() => setType("BUG")}
                className={[
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  type === "BUG" ? "bg-red-50 text-red-700" : "text-slate-500 hover:text-slate-700",
                ].join(" ")}
              >
                <Bug className="w-3.5 h-3.5" />
                Bug
              </button>
            </div>
          </div>
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
          <div className="flex flex-col gap-1">
            <label htmlFor="fb-attachments" className="text-xs font-medium text-slate-600">
              Attachments
            </label>
            <input
              id="fb-attachments"
              type="file"
              multiple
              accept="image/*,application/pdf,text/plain,text/csv"
              onChange={handleFileSelect}
              className="text-xs text-slate-500 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-slate-600 hover:file:bg-slate-200"
            />
            {attachmentError && <p className="text-xs text-red-500">{attachmentError}</p>}
            {pendingAttachments.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-1">
                {pendingAttachments.map((a) => (
                  <div
                    key={a.clientId}
                    className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs max-w-[12rem]"
                  >
                    {a.status === "done" && a.fileType?.startsWith("image/") ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={a.url} alt={a.filename} className="w-6 h-6 rounded object-cover shrink-0" />
                    ) : (
                      <FileIcon className="w-3.5 h-3.5 shrink-0 text-slate-400" />
                    )}
                    <span className="truncate flex-1 text-slate-600">{a.file.name}</span>
                    {a.status === "uploading" && (
                      <Loader2 className="w-3.5 h-3.5 shrink-0 text-slate-400 animate-spin" />
                    )}
                    <button
                      type="button"
                      onClick={() => handleRemoveAttachment(a.clientId)}
                      className="shrink-0 text-slate-400 hover:text-slate-600"
                      aria-label={`Remove ${a.file.name}`}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                    {a.status === "error" && (
                      <span className="w-full text-red-500 basis-full">{a.error}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
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
            disabled={isSubmitting || isUploadingAttachments || !title.trim() || requiresSignIn}
            className="self-start rounded-lg bg-indigo-600 text-white text-sm px-4 py-2 hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {isSubmitting ? "Submitting..." : isUploadingAttachments ? "Uploading..." : "Submit"}
          </button>
        </form>
      </div>

      {/* Feedback list */}
      {items.length > 0 && (
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-slate-800">
            {items.length} {items.length === 1 ? "submission" : "submissions"}
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
                        "flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium shrink-0",
                        TYPE_COLORS[item.type] ?? "bg-slate-100 text-slate-600",
                      ].join(" ")}
                    >
                      {item.type === "BUG" ? <Bug className="w-3 h-3" /> : <Lightbulb className="w-3 h-3" />}
                      {TYPE_LABELS[item.type] ?? item.type}
                    </span>
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
                  <FeedbackAttachments attachments={item.attachments} />
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
