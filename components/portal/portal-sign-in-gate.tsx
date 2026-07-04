"use client";

import { useState } from "react";
import { Mail } from "lucide-react";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Props {
  /** Short copy explaining what signing in unlocks, e.g. "vote" or "submit feedback". */
  actionLabel: string;
}

/**
 * "Enter your email to continue" mini-flow for portalAuthRequired workspaces.
 * Posts to /api/portal/auth/send and shows a "check your email" confirmation —
 * no client-side session polling; the visitor re-visits after clicking the
 * emailed link (which redirects back to window.location.pathname).
 */
export function PortalSignInGate({ actionLabel }: Props) {
  const [email, setEmail] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setError("Enter a valid email address");
      return;
    }

    setIsSending(true);
    try {
      const returnTo =
        typeof window !== "undefined" ? window.location.pathname : undefined;
      await fetch("/api/portal/auth/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed, returnTo }),
      });
      setSent(true);
    } catch {
      setError("Network error — please try again");
    } finally {
      setIsSending(false);
    }
  }

  if (sent) {
    return (
      <div className="flex items-start gap-2 rounded-lg bg-indigo-50 border border-indigo-100 px-3 py-2 text-xs text-indigo-700">
        <Mail className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <span>Check your email — we sent a sign-in link to {email.trim()}.</span>
      </div>
    );
  }

  return (
    <form onSubmit={handleSend} className="flex flex-col gap-2">
      <label className="text-xs font-medium text-slate-600">
        Sign in with email to {actionLabel}
      </label>
      <div className="flex gap-2">
        <input
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="flex-1 text-xs rounded-lg border border-slate-200 px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400"
        />
        <button
          type="submit"
          disabled={isSending}
          className="shrink-0 text-xs rounded-lg bg-indigo-600 text-white px-3 py-1.5 hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          {isSending ? "Sending..." : "Send magic link"}
        </button>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </form>
  );
}
