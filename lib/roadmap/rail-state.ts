/**
 * Open/closed state of the "Ready to schedule" rail on the roadmap timeline.
 *
 * The explicit choice lives in a cookie, not localStorage: the roadmap page is
 * a server component, so it can read the cookie and render the rail in its
 * final state on the first paint. localStorage would paint the default and
 * then animate to the saved state after hydration.
 *
 * Only an explicit choice is stored. With no cookie the rail follows a
 * default that depends on the viewport (open beside the chart on wide
 * screens, closed when it would stack above the chart) which the server cannot
 * know; that default is expressed in CSS so it too is right on first paint.
 */

export const RAIL_COOKIE_NAME = "compass_roadmap_rail";
/** One year: a layout preference should not quietly expire. */
export const RAIL_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
/** The width at which the rail sits beside the timeline instead of above it. Keep in step with the `min-[1320px]` classes in the rail region. */
export const RAIL_WIDE_MIN_VIEWPORT = 1320;
export const RAIL_WIDE_MEDIA_QUERY = `(min-width: ${RAIL_WIDE_MIN_VIEWPORT}px)`;

export type RailPreference = "open" | "closed";

/** Tolerant: this is read during a server render, so a bad cookie must never throw. */
export function parseRailPreference(value: string | null | undefined): RailPreference | null {
  return value === "open" || value === "closed" ? value : null;
}

export function railCookieString(preference: RailPreference): string {
  return `${RAIL_COOKIE_NAME}=${preference}; path=/; max-age=${RAIL_COOKIE_MAX_AGE}; samesite=lax`;
}

export function resolveRailOpen({ preference, wide, empty }: { preference: RailPreference | null; wide: boolean; empty: boolean }): boolean {
  if (preference) return preference === "open";
  return wide || empty;
}
