"use client";

import { useLiveRefresh } from "@/hooks/use-live-refresh";

/**
 * Keeps the server-rendered OKR pages (cycles index, Outcomes index, cycle
 * detail) live: polls the "okrs" change token and refreshes the route when an
 * objective, key result, check-in or cycle changes elsewhere. Renders nothing.
 * The lists below adopt the refreshed data via useServerSyncedState, deferring
 * while a local drag or save is in flight.
 */
export function OkrLiveRefresh({ orgSlug, workspaceSlug }: { orgSlug: string; workspaceSlug: string }) {
  useLiveRefresh({ orgSlug, workspaceSlug, scope: "okrs" });
  return null;
}
