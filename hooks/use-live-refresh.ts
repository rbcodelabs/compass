"use client";

import { useEffect, useRef, startTransition } from "react";
import { useRouter } from "next/navigation";
import type { EntityLiveScope, LiveScope } from "@/lib/live-change-token";

export const LIVE_REFRESH_INTERVAL_MS = 5_000;
export const LIVE_REFRESH_MAX_BACKOFF_MS = 60_000;

/** Delay before the next poll: the base interval, doubling per consecutive failure up to a cap. */
export function nextPollDelay(
  consecutiveFailures: number,
  intervalMs: number = LIVE_REFRESH_INTERVAL_MS,
  maxMs: number = LIVE_REFRESH_MAX_BACKOFF_MS,
): number {
  if (consecutiveFailures <= 0) return intervalMs;
  return Math.min(intervalMs * 2 ** consecutiveFailures, maxMs);
}

type Options = {
  orgSlug: string;
  workspaceSlug: string;
  scope: LiveScope | EntityLiveScope;
  /** Required for the `cardSort` scope. */
  roundId?: string;
  /**
   * True while the UI holds state a refresh must not disturb (a drag in flight,
   * a pending local mutation). A change seen while paused is *not* consumed:
   * the next poll sees it again and refreshes once the pause lifts.
   */
  paused?: boolean;
  /** False stops polling entirely (e.g. the surface is mounted but not showing). Default true. */
  enabled?: boolean;
  /**
   * Replaces `router.refresh()` when the token changes. For client-fetched data
   * (e.g. the rail's Library tree) that a server refresh would not reach.
   */
  onChange?: () => void;
  /** Runs right before `router.refresh()`, e.g. to snapshot card positions for FLIP. */
  onBeforeRefresh?: () => void;
  intervalMs?: number;
};

/**
 * Keeps a server-rendered board live by polling a cheap change token and calling
 * `router.refresh()` only when it changes.
 *
 * - Polls while the tab is visible; stops when hidden and polls immediately on
 *   return (visibilitychange / focus).
 * - The first successful poll only records a baseline, so mounting never
 *   triggers a refresh by itself.
 * - Errors back off exponentially (capped) and never refresh.
 */
export function useLiveRefresh({
  orgSlug,
  workspaceSlug,
  scope,
  roundId,
  paused = false,
  enabled = true,
  onBeforeRefresh,
  onChange,
  intervalMs = LIVE_REFRESH_INTERVAL_MS,
}: Options): void {
  const router = useRouter();

  // Latest values read by the long-lived poll loop without restarting it.
  const pausedRef = useRef(paused);
  const beforeRefreshRef = useRef(onBeforeRefresh);
  const onChangeRef = useRef(onChange);
  const routerRef = useRef(router);
  useEffect(() => {
    pausedRef.current = paused;
    beforeRefreshRef.current = onBeforeRefresh;
    onChangeRef.current = onChange;
    routerRef.current = router;
  });

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    let lastToken: string | null = null;
    let failures = 0;
    let stopped = false;

    const url =
      `/api/live/change-token?orgSlug=${encodeURIComponent(orgSlug)}` +
      `&workspaceSlug=${encodeURIComponent(workspaceSlug)}&scope=${encodeURIComponent(scope)}` +
      (roundId ? `&roundId=${encodeURIComponent(roundId)}` : "");

    function clearTimer() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    }

    function schedule() {
      clearTimer();
      if (stopped || document.visibilityState === "hidden") return;
      timer = setTimeout(poll, nextPollDelay(failures, intervalMs));
    }

    async function poll() {
      clearTimer();
      if (stopped || document.visibilityState === "hidden") return;
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`change-token ${response.status}`);
        const body = (await response.json()) as { token?: unknown };
        if (typeof body.token !== "string") throw new Error("change-token: malformed response");
        failures = 0;
        if (lastToken === null) {
          lastToken = body.token;
        } else if (body.token !== lastToken && !pausedRef.current) {
          lastToken = body.token;
          beforeRefreshRef.current?.();
          const handler = onChangeRef.current;
          if (handler) handler();
          else startTransition(() => routerRef.current.refresh());
        }
      } catch (error) {
        if ((error as { name?: string }).name === "AbortError") return;
        failures += 1;
      }
      schedule();
    }

    function onVisibilityOrFocus() {
      if (document.visibilityState === "hidden") {
        clearTimer();
        controller?.abort();
        return;
      }
      void poll();
    }

    document.addEventListener("visibilitychange", onVisibilityOrFocus);
    window.addEventListener("focus", onVisibilityOrFocus);
    void poll();

    return () => {
      stopped = true;
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityOrFocus);
      window.removeEventListener("focus", onVisibilityOrFocus);
    };
  }, [enabled, orgSlug, workspaceSlug, scope, roundId, intervalMs]);
}
