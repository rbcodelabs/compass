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

  async function handleSend() {
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
    <div className="flex flex-col gap-2">
      <label htmlFor="portal-sign-in-email" className="text-xs font-medium text-text-secondary">
        Sign in with email to {actionLabel}
      </label>
      <div className="flex gap-2">
        <input
          type="email"
          id="portal-sign-in-email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="flex-1 rounded-lg border border-border-default px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={isSending}
          className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/80 disabled:opacity-50"
        >
          {isSending ? "Sending..." : "Send magic link"}
        </button>
      </div>
      {error && <p role="alert" className="text-xs text-status-danger">{error}</p>}
    </div>
  );
}
