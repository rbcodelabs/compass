/**
 * Persisted open/closed state for collapsible detail-panel sections.
 *
 * A cookie, not localStorage, on purpose: a cookie is readable during the
 * server render (`cookies().get(PANEL_SECTION_COOKIE_NAME)`) and readable
 * synchronously on the client while rendering, so a section can resolve its
 * state before it first paints. The `localStorage` + `useEffect` pattern in
 * `components/discovery/discovery-rail.tsx` cannot: its first paint always
 * shows the default, then flips once the effect runs.
 *
 * The whole map lives in one cookie so adding sections never multiplies the
 * number of cookies sent on every request.
 */

export const PANEL_SECTION_COOKIE_NAME = "panel_sections";
export const PANEL_SECTION_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

/**
 * State is keyed by panel type *and* section label, so a Solution panel's
 * "Evidence" and a Roadmap Item panel's "Launch" never share an entry.
 */
export function panelSectionStateKey(panelType: string, label: string): string {
  return `${panelType}:${label}`;
}

export function parsePanelSectionState(
  raw: string | null | undefined
): Record<string, boolean> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const state: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") state[key] = value;
    }
    return state;
  } catch {
    // A hand-edited or truncated cookie falls back to the per-type defaults
    // rather than breaking the panel.
    return {};
  }
}

export function serializePanelSectionState(state: Record<string, boolean>): string {
  return encodeURIComponent(JSON.stringify(state));
}

/** Read the whole map from `document.cookie`. Returns `{}` on the server. */
export function readPanelSectionState(): Record<string, boolean> {
  if (typeof document === "undefined") return {};
  const raw = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${PANEL_SECTION_COOKIE_NAME}=`))
    ?.slice(PANEL_SECTION_COOKIE_NAME.length + 1);
  return parsePanelSectionState(raw);
}

/** Merge one section's state into the cookie, leaving the others intact. */
export function writePanelSectionOpen(key: string, open: boolean): void {
  if (typeof document === "undefined") return;
  const next = { ...readPanelSectionState(), [key]: open };
  document.cookie = `${PANEL_SECTION_COOKIE_NAME}=${serializePanelSectionState(next)}; path=/; max-age=${PANEL_SECTION_COOKIE_MAX_AGE}`;
}
