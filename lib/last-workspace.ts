/**
 * The workspace a person last used, remembered in a cookie so account and
 * organization settings can name it.
 *
 * Account settings (/settings/*) and organization settings (/{org}/settings)
 * have no workspace in their URL, but their navigation still has a Workspace
 * group. Without a hint they anchored on the first workspace in the list, which
 * is often not the one the person came from. The workspace layout writes this
 * cookie from the client (the same pattern as lib/panel-pin.ts) and the two
 * layouts read it on the server.
 *
 * It is only a preference. `pickAnchorWorkspace` resolves it against the
 * workspaces the person actually belongs to, so a stale, truncated or
 * hand-edited value can never point at a workspace they cannot use; it just
 * falls back to the first one.
 *
 * Format: "{orgSlug}/{workspaceSlug}". Both parts are restricted to characters
 * that are already cookie-safe, so nothing needs encoding on either side.
 */
export const LAST_WORKSPACE_COOKIE = "compass_last_workspace";
export const LAST_WORKSPACE_MAX_AGE = 60 * 60 * 24 * 365;

const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

export type LastWorkspace = { orgSlug: string; workspaceSlug: string };

/** Never throws; anything that is not exactly "{org}/{workspace}" with plain slugs is ignored. */
export function parseLastWorkspace(raw: string | undefined | null): LastWorkspace | null {
  if (!raw) return null;
  const parts = raw.split("/");
  if (parts.length !== 2) return null;
  const [orgSlug, workspaceSlug] = parts;
  if (!SLUG.test(orgSlug) || !SLUG.test(workspaceSlug)) return null;
  return { orgSlug, workspaceSlug };
}

/** The cookie value, or null when either slug is not cookie-safe (then nothing is written). */
export function serializeLastWorkspace(orgSlug: string, workspaceSlug: string): string | null {
  if (!SLUG.test(orgSlug) || !SLUG.test(workspaceSlug)) return null;
  return `${orgSlug}/${workspaceSlug}`;
}

/** A complete `document.cookie` assignment, or null when there is nothing safe to write. */
export function lastWorkspaceCookieString(orgSlug: string, workspaceSlug: string, secure = false): string | null {
  const value = serializeLastWorkspace(orgSlug, workspaceSlug);
  if (value === null) return null;
  return `${LAST_WORKSPACE_COOKIE}=${value}; path=/; max-age=${LAST_WORKSPACE_MAX_AGE}; samesite=lax${secure ? "; secure" : ""}`;
}

/**
 * The workspace to anchor settings navigation on: the remembered one when the
 * person still belongs to it, otherwise the first candidate. With `orgSlug`
 * only that organization's workspaces are considered, so organization settings
 * never name a workspace from another organization.
 */
export function pickAnchorWorkspace<T extends { orgSlug: string; slug: string }>(
  workspaces: readonly T[],
  rawCookie: string | undefined | null,
  options: { orgSlug?: string } = {},
): T | undefined {
  const candidates = options.orgSlug ? workspaces.filter((w) => w.orgSlug === options.orgSlug) : workspaces;
  const remembered = parseLastWorkspace(rawCookie);
  if (remembered) {
    const match = candidates.find((w) => w.orgSlug === remembered.orgSlug && w.slug === remembered.workspaceSlug);
    if (match) return match;
  }
  return candidates[0];
}
