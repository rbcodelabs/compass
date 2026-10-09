/**
 * Persistence for the Docs "Library" sidebar — pure, no React, no DOM.
 *
 * Same contract as `lib/panel-pin.ts`, deliberately: the value lives in a
 * cookie so the docs layout (a server component) can render the sidebar at the
 * right width and in the right open/collapsed state on the very first paint.
 * Keeping it in localStorage would flash the default width on every load.
 *
 * Format is `"<0|1>:<width>"` — only cookie-safe characters, so the
 * `document.cookie` writer and the `cookies()` reader never disagree about
 * encoding. `collapsed` is `1` when the sidebar is folded away; the width is
 * retained while collapsed so re-expanding restores where the user left it.
 *
 * Every reader is tolerant: this is parsed during a server render, so a
 * truncated or hand-edited cookie degrades to the default and never throws.
 *
 * This has its own bounds rather than reusing `PANEL_WIDTH_MIN/MAX` — those
 * (320–720) describe right-hand detail panels and would make a navigation tree
 * wider than its 240px default.
 */

export const DOCS_LIBRARY_COOKIE_NAME = "compass_docs_library";

export const DOCS_LIBRARY_WIDTH_MIN = 200;
export const DOCS_LIBRARY_WIDTH_DEFAULT = 240;
export const DOCS_LIBRARY_WIDTH_MAX = 480;

/** The doc editor never yields below this when the sidebar is dragged wider. */
export const DOCS_LIBRARY_MIN_MAIN = 480;

/** One year — a layout preference should not quietly expire. */
export const DOCS_LIBRARY_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export type DocsLibraryState = {
  collapsed: boolean;
  width: number;
};

export const DEFAULT_DOCS_LIBRARY_STATE: DocsLibraryState = Object.freeze({
  collapsed: false,
  width: DOCS_LIBRARY_WIDTH_DEFAULT,
});

const WIDTH_PATTERN = /^\d{1,4}$/;

/** Non-finite input becomes the default rather than a zero-width sidebar. */
export function clampDocsLibraryWidth(width: number): number {
  if (!Number.isFinite(width)) return DOCS_LIBRARY_WIDTH_DEFAULT;
  return Math.min(
    DOCS_LIBRARY_WIDTH_MAX,
    Math.max(DOCS_LIBRARY_WIDTH_MIN, Math.round(width)),
  );
}

export function parseDocsLibraryState(
  raw: string | undefined | null,
): DocsLibraryState {
  if (!raw) return DEFAULT_DOCS_LIBRARY_STATE;

  const separator = raw.indexOf(":");
  if (separator <= 0) return DEFAULT_DOCS_LIBRARY_STATE;

  const flag = raw.slice(0, separator);
  const width = raw.slice(separator + 1);

  if (flag !== "0" && flag !== "1") return DEFAULT_DOCS_LIBRARY_STATE;
  if (!WIDTH_PATTERN.test(width)) return DEFAULT_DOCS_LIBRARY_STATE;

  return { collapsed: flag === "1", width: clampDocsLibraryWidth(Number(width)) };
}

export function serializeDocsLibraryState(state: DocsLibraryState): string {
  return `${state.collapsed ? "1" : "0"}:${clampDocsLibraryWidth(state.width)}`;
}

/** A complete `document.cookie` assignment value. */
export function docsLibraryCookieString(state: DocsLibraryState): string {
  return [
    `${DOCS_LIBRARY_COOKIE_NAME}=${serializeDocsLibraryState(state)}`,
    "Path=/",
    `Max-Age=${DOCS_LIBRARY_COOKIE_MAX_AGE}`,
    "SameSite=Lax",
  ].join("; ");
}
