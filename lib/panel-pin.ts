/**
 * Pin state for the right-hand side panels — pure, no React, no DOM.
 *
 * A detail panel can be an overlay (today's modal Sheet) or pinned into the
 * layout as a real column. Which one a user gets has to be decided on the
 * *server*, during the first render, or a pinned user watches a modal flash
 * and slide away on every page load. So the preference lives in a cookie:
 * `cookies()` can read it in a layout, and `document.cookie` can write it from
 * a click handler.
 *
 * ## Why `"<0|1>:<width>"` and not JSON
 *
 * A JSON cookie value contains `{`, `"` and `,`, so it has to be URI-encoded
 * on the way out. The client writes with `document.cookie` (no automatic
 * encoding) and the server reads with `cookies()` (no automatic decoding), so
 * the encode/decode responsibility sits on two different call sites that can
 * disagree — and when they do, the failure is silent: `width` comes back as
 * `NaN` and the panel renders at zero. This format uses only characters that
 * are already cookie-safe and URI-safe, which removes the question entirely.
 * `__tests__/lib/panel-pin.test.ts` asserts that property directly.
 *
 * ## Why every reader is tolerant
 *
 * This value is read during a server render of pages that have nothing to do
 * with panel pinning. A cookie can arrive truncated, stale from an older
 * format, or hand-edited from devtools. A throw here would be a 500 on the
 * Roadmap. So `parsePanelPin` never throws and never returns a width outside
 * the supported range: anything it does not fully recognise becomes
 * `DEFAULT_PANEL_PIN`.
 *
 * ## Why it is keyed by `PanelId`
 *
 * Phase 1 only pins the global detail panel. The two Docs panels (Comments,
 * Version History) are Phase 2. Keying the cookie name by panel id from day
 * one means Phase 2 adds call sites and nothing else — no cookie migration,
 * no format change, and no shared "one panel wins" slot, which would let
 * pinning Comments in Docs silently unpin the detail panel on the Roadmap.
 */

/**
 * Every panel that can be pinned, including the two Phase 2 Docs panels.
 * Reserved here deliberately — see the module doc.
 *
 * ## `"agent"` is a left-hand rail, and reads `pinned` as "docked open"
 *
 * The agent rail is the one entry here that is not a right-hand detail panel,
 * and it uses this module's shape with one deliberate reinterpretation: its
 * `pinned` flag means *the rail is open*, not *the user prefers a column over
 * an overlay*.
 *
 * That is not a shortcut — the rail genuinely has no overlay-vs-column
 * preference to store. A detail panel's overlay mode is a user choice, so it
 * needs a bit. The rail's overlay mode is forced by arithmetic: nav + rail +
 * main's 480px floor + an open detail panel do not always fit, and when they
 * do not, the rail is the one that yields (the detail panel never moves). That
 * decision is made from live layout measurement at render time, so there is
 * nothing about it worth persisting. What *is* worth persisting is whether the
 * rail was open, which is exactly one bit — so it reuses this one rather than
 * adding a second cookie that could disagree with it.
 *
 * The width half of the value is used unchanged, and the shared
 * PANEL_WIDTH_MIN/MAX bounds already suit a chat column, so the rail needs no
 * constants of its own.
 */
export const PANEL_IDS = [
  "detail",
  "docsComments",
  "docsHistory",
  "artifactComments",
  "agent",
] as const;

export type PanelId = (typeof PANEL_IDS)[number];

/** Narrowest useful panel. Below this the entity forms wrap unusably. */
export const PANEL_WIDTH_MIN = 320;

/** Matches the overlay Sheet's current `sm:max-w-md`, so pinning does not resize. */
export const PANEL_WIDTH_DEFAULT = 448;

export const PANEL_WIDTH_MAX = 720;

/**
 * Main content never yields below this. Enforced three independent times, each
 * against a different failure:
 *
 *  1. `clampPanelWidth` guards *persistence* — a hand-edited cookie cannot
 *     produce a 9000px panel on the next server render.
 *  2. The drag handler recomputes a gesture bound from the live layout at
 *     pointerdown, so the panel stops exactly where the pointer does. Clamping
 *     only on commit gives the classic rubber-band bug: the panel freezes
 *     while the cursor keeps travelling, then jumps on release.
 *  3. A CSS `clamp()` on the pinned aside's width (see
 *     `.panel-pinned-surface` in app/globals.css) guards *window resize*,
 *     which involves no JS at all.
 */
export const PANEL_MIN_MAIN = 480;

/**
 * Below this viewport width, pinning is suspended: at 900px with the sidebar
 * open and a 448px panel, main content gets ~230px — broken, not "narrow".
 *
 * This constant and the `lg:` Tailwind variant on the pinned aside are the
 * same number by construction (Tailwind's `lg` breakpoint is 1024px). The CSS
 * gate is the load-bearing one — it cannot paint a pinned panel at a width
 * where pinning is illegal regardless of what JS believes or when it runs.
 * The JS constant exists so the media query that demotes to overlay agrees.
 */
export const PANEL_PIN_MIN_VIEWPORT = 1024;

/** The media query that decides whether a pin preference can be honoured. */
export const PANEL_PIN_MEDIA_QUERY = `(min-width: ${PANEL_PIN_MIN_VIEWPORT}px)`;

/** One year. A layout preference should not quietly expire mid-project. */
export const PANEL_PIN_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export type PanelPin = {
  pinned: boolean;
  width: number;
};

/**
 * Cookie-absent default. Unpinned, everywhere — this is what keeps every
 * existing `[data-slot="sheet-content"]` spec green, and what makes reverting
 * this feature a pure code revert with no data to undo.
 */
export const DEFAULT_PANEL_PIN: PanelPin = Object.freeze({
  pinned: false,
  width: PANEL_WIDTH_DEFAULT,
});

const COOKIE_PREFIX = "compass_panel_";

/** Exactly 1–4 digits. Wider than any supported width, narrow enough to reject junk. */
const WIDTH_PATTERN = /^\d{1,4}$/;

export function isPanelId(value: string): value is PanelId {
  return (PANEL_IDS as readonly string[]).includes(value);
}

export function panelPinCookieName(panelId: PanelId): string {
  return `${COOKIE_PREFIX}${panelId}`;
}

/**
 * Clamp a width to the supported range. Non-finite input (a `NaN` from a
 * mis-decoded cookie, an `Infinity` from a division) becomes the default
 * rather than propagating — a `NaN` width silently renders a zero-width panel,
 * which looks like the feature is broken rather than like bad input.
 */
export function clampPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return PANEL_WIDTH_DEFAULT;
  return Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, Math.round(width)));
}

/**
 * Parse a raw cookie value. Never throws; anything unrecognised is the
 * default. Rules are deliberately strict — a partial match is treated as
 * corruption, not as something to salvage.
 */
export function parsePanelPin(raw: string | undefined | null): PanelPin {
  if (!raw) return DEFAULT_PANEL_PIN;

  const separator = raw.indexOf(":");
  if (separator <= 0) return DEFAULT_PANEL_PIN;

  const flag = raw.slice(0, separator);
  const width = raw.slice(separator + 1);

  if (flag !== "0" && flag !== "1") return DEFAULT_PANEL_PIN;
  if (!WIDTH_PATTERN.test(width)) return DEFAULT_PANEL_PIN;

  return { pinned: flag === "1", width: clampPanelWidth(Number(width)) };
}

/**
 * Read a cookie value for a panel id that may not be trusted — e.g. an id
 * threaded through from a call site that has drifted. An unrecognised id
 * yields the default rather than the value of whatever cookie happened to be
 * passed with it.
 */
export function panelPinFromCookieValue(
  panelId: string,
  raw: string | undefined | null,
): PanelPin {
  if (!isPanelId(panelId)) return DEFAULT_PANEL_PIN;
  return parsePanelPin(raw);
}

/**
 * Serialize, clamping on the way out. Clamping here as well as on read means a
 * bad in-memory width can never reach the cookie in the first place, so the
 * stored value is always one this module would accept back.
 */
export function serializePanelPin(pin: PanelPin): string {
  return `${pin.pinned ? "1" : "0"}:${clampPanelWidth(pin.width)}`;
}

/**
 * A complete `document.cookie` assignment value.
 *
 * `SameSite=Lax` is explicit: browsers differ on the unset default, and a
 * layout preference that silently stops persisting in one browser is exactly
 * the kind of bug nobody files.
 */
export function panelPinCookieString(panelId: PanelId, pin: PanelPin): string {
  return [
    `${panelPinCookieName(panelId)}=${serializePanelPin(pin)}`,
    "Path=/",
    `Max-Age=${PANEL_PIN_COOKIE_MAX_AGE}`,
    "SameSite=Lax",
  ].join("; ");
}
