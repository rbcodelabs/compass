"use client";

import { useEffect } from "react";
import { lastWorkspaceCookieString } from "@/lib/last-workspace";

/**
 * Records the workspace being used so account and organization settings, which
 * have no workspace in their URL, can name the one the person came from. See
 * lib/last-workspace.ts. Renders nothing.
 */
export function RememberWorkspace({ orgSlug, workspaceSlug }: { orgSlug: string; workspaceSlug: string }) {
  useEffect(() => {
    const cookie = lastWorkspaceCookieString(orgSlug, workspaceSlug, window.location.protocol === "https:");
    if (cookie) document.cookie = cookie;
  }, [orgSlug, workspaceSlug]);
  return null;
}
