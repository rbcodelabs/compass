"use client";

/**
 * The popup's body. A state machine over one server action.
 *
 * ## Why it polls, and which mode actually needs it
 *
 * On the PORTAL path the visitor signs in by clicking a link in their email, which
 * opens in whatever window their mail client decides. That new tab is where the
 * portal cookie gets set. Nothing can redirect this popup back here afterwards, and
 * nothing can message it, so the only way this window learns the visitor is signed
 * in is by asking again.
 *
 * On the INTERNAL_SSO path none of that applies: the login is a same-window
 * navigation that returns to this exact URL, so the answer arrives as a reload. The
 * poll is kept running anyway — it is one metered read every 2.5s and it covers a
 * session established in another tab — but it is a fallback there, not the
 * mechanism. Anyone shortening this loop should know it is load-bearing for only one
 * of the two modes.
 *
 * The interval is metered server-side on the source's read quota.
 *
 * The popup never receives a credential. The action's success only says a handoff
 * is waiting; the widget that opened this window is what exchanges it, on its own
 * authenticated request.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { PortalSignInGate } from "@/components/portal/portal-sign-in-gate";
import { depositEmbedSignIn, type EmbedSignInResult } from "./actions";

/** ~24 polls/minute, comfortably inside the 120/min read ceiling. */
const POLL_INTERVAL_MS = 2500;

/**
 * An abandoned popup stops asking. Long enough to read an email and come back,
 * short enough that a window left open overnight is not still polling at dawn.
 */
const POLL_CEILING_MS = 10 * 60 * 1000;

type State = { status: "checking" } | EmbedSignInResult | { status: "abandoned" };

export function EmbedSignInPopup({
  token,
  nonce,
  ssoHref,
}: {
  token: string;
  nonce: string;
  /** Built server-side in page.tsx, because the choice depends on the auth strategy. */
  ssoHref: string;
}) {
  const [state, setState] = useState<State>({ status: "checking" });
  const startedAt = useRef<number | null>(null);

  const check = useCallback(async () => {
    const result = await depositEmbedSignIn({ token, nonce });
    setState(result);
    return result.status;
  }, [token, nonce]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      // React 19 double-invokes effects in development. `cancelled` keeps the
      // unmounted pass from scheduling a second poll loop against the same nonce
      // — harmless on the server, which treats a repeat deposit as success, but it
      // would double the request rate for no reason.
      if (cancelled) return;
      const status = await check().catch(() => "signin_required" as const);
      // `not_authorized` is terminal alongside the other two: the visitor is signed
      // in and the answer will not change by asking again. Only signing in as
      // someone else will, and that is a navigation, which reloads this component.
      if (cancelled || status === "deposited" || status === "unavailable" || status === "not_authorized") return;

      startedAt.current ??= Date.now();
      if (Date.now() - startedAt.current > POLL_CEILING_MS) {
        setState({ status: "abandoned" });
        return;
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [check]);

  if (state.status === "checking") {
    return <Shell>Checking your sign-in…</Shell>;
  }

  if (state.status === "deposited") {
    return (
      <Shell heading="You are signed in">
        <p className="text-sm text-muted-foreground">
          Signed in as {state.email}. Return to the page you came from — your comment box is ready.
        </p>
        <button
          type="button"
          onClick={() => window.close()}
          className="mt-4 rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/80"
        >
          Close this window
        </button>
      </Shell>
    );
  }

  if (state.status === "unavailable") {
    return (
      <Shell heading="This sign-in link cannot be used">
        <p role="alert" className="text-sm text-status-danger">
          {state.error}
        </p>
        <p className="mt-2 text-xs text-text-subtle">
          Close this window and try the comment button again.
        </p>
      </Shell>
    );
  }

  if (state.status === "not_authorized") {
    return (
      <Shell heading="Your account cannot comment here">
        <p role="alert" className="text-sm text-muted-foreground">
          You are signed in as {state.email}, but that account is not a member of the workspace this
          prototype belongs to.
        </p>
        <p className="mt-2 text-xs text-text-subtle">
          Ask whoever shared the prototype to add you to its workspace, then try again.
        </p>
      </Shell>
    );
  }

  if (state.status === "abandoned") {
    return (
      <Shell heading="This window timed out">
        <p className="text-sm text-muted-foreground">
          Close it and press the comment button again to start over.
        </p>
      </Shell>
    );
  }

  // Signed out. Which affordance depends on the source's mode, which only the
  // server knows — the widget cannot declare itself internal.
  if (state.mode === "INTERNAL_SSO") {
    return (
      <Shell heading="Sign in to leave feedback">
        <p className="mb-4 text-sm text-muted-foreground">
          This prototype takes comments from your team. Sign in with your Compass account and your
          comments are filed under your name.
        </p>
        <a
          href={ssoHref}
          className="inline-block rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/80"
        >
          Sign in with SSO
        </a>
        <p className="mt-4 text-xs text-text-subtle">
          You will come back to this window once you are signed in.
        </p>
      </Shell>
    );
  }

  return (
    <Shell heading="Sign in to leave feedback">
      <p className="mb-4 text-sm text-muted-foreground">
        Your comment is published with your email address, so the team can follow up. Signing in
        happens here on Compass — the page you came from never sees your credentials.
      </p>
      <PortalSignInGate actionLabel="leave feedback" />
      <p className="mt-4 text-xs text-text-subtle">
        Keep this window open. After you click the link in your email, it will finish on its own.
      </p>
    </Shell>
  );
}

function Shell({ heading, children }: { heading?: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 py-10">
      <div className="rounded-xl border border-border bg-card p-5">
        {heading && <h1 className="mb-2 text-base font-semibold">{heading}</h1>}
        {children}
      </div>
    </main>
  );
}
