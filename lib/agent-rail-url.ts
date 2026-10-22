/**
 * Encoding of the agent rail's state into URL search params.
 *
 * Pure and framework-free so it can be unit tested; the provider in
 * components/agent/agent-rail-context.tsx owns when it is read and written.
 *
 * Params (all omitted when they hold the default, so a rail that is simply open
 * on a fresh chat leaves the URL untouched):
 *
 *   rail=help|library   which view; absent means "agent"
 *   rc=<conversationId> the active agent thread; absent means "new chat"
 *   ra=<slug>[#anchor]  the open Help article (and heading); Help view only
 *
 * Open/closed is deliberately not a param of its own: it is the
 * `compass_panel_agent` cookie. The URL can only ever *open* the rail (any valid
 * rail param does), never close it, and a closed rail writes no params.
 */

/** The views the rail can show. Add an id here and a row in VIEWS (agent-rail.tsx) to add one. */
export type RailView = "agent" | "help" | "library";

export const RAIL_VIEWS: readonly RailView[] = ["agent", "help", "library"];

export const RAIL_VIEW_PARAM = "rail";
export const RAIL_CONVERSATION_PARAM = "rc";
export const RAIL_ARTICLE_PARAM = "ra";

export const RAIL_PARAMS = [RAIL_VIEW_PARAM, RAIL_CONVERSATION_PARAM, RAIL_ARTICLE_PARAM] as const;

export type HelpArticleRef = { slug: string; anchor?: string };

export type RailUrlState = {
  open: boolean;
  view: RailView;
  conversationId: string | null;
  helpArticle: HelpArticleRef | null;
};

const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const SLUG_PATTERN = /^[A-Za-z0-9-]{1,100}$/;
const MAX_ANCHOR = 200;

type ParamSource = { get(name: string): string | null };

/** `ra` value for an article: `slug` or `slug#anchor`. */
export function encodeHelpArticle(article: HelpArticleRef): string {
  return article.anchor ? `${article.slug}#${article.anchor}` : article.slug;
}

export function decodeHelpArticle(raw: string | null): HelpArticleRef | null {
  if (!raw) return null;
  const hash = raw.indexOf("#");
  const slug = hash === -1 ? raw : raw.slice(0, hash);
  if (!SLUG_PATTERN.test(slug)) return null;
  const anchor = hash === -1 ? "" : raw.slice(hash + 1);
  return anchor && anchor.length <= MAX_ANCHOR ? { slug, anchor } : { slug };
}

export function decodeConversationId(raw: string | null): string | null {
  return raw && ID_PATTERN.test(raw) ? raw : null;
}

/**
 * Rail state requested by a URL. `open` is true when any valid rail param is
 * present, which is how a shared link opens the rail for someone whose cookie
 * says it is closed. Returns `null` when the URL carries no rail state, so the
 * caller keeps its cookie-derived defaults.
 */
export function decodeRailParams(params: ParamSource): RailUrlState | null {
  const rawView = params.get(RAIL_VIEW_PARAM);
  const explicitView = RAIL_VIEWS.find((v) => v === rawView) ?? null;
  const conversationId = decodeConversationId(params.get(RAIL_CONVERSATION_PARAM));
  const helpArticle = decodeHelpArticle(params.get(RAIL_ARTICLE_PARAM));

  if (!explicitView && !conversationId && !helpArticle) return null;

  // An article with no explicit view can only mean the Help view.
  const view: RailView = explicitView ?? (helpArticle ? "help" : "agent");
  return {
    open: true,
    view,
    conversationId,
    helpArticle: view === "help" ? helpArticle : null,
  };
}

/**
 * Returns a copy of `current` with the rail params replaced by `state`'s.
 * Every other param (`detail`, filters, `c`, ...) is left exactly as it was,
 * in its original order.
 */
export function applyRailParams(current: URLSearchParams, state: RailUrlState): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const name of RAIL_PARAMS) next.delete(name);
  if (!state.open) return next;

  if (state.view !== "agent") next.set(RAIL_VIEW_PARAM, state.view);
  if (state.conversationId) next.set(RAIL_CONVERSATION_PARAM, state.conversationId);
  if (state.view === "help" && state.helpArticle) {
    next.set(RAIL_ARTICLE_PARAM, encodeHelpArticle(state.helpArticle));
  }
  return next;
}

/**
 * Re-applies the rail's params to a carried-over URL, or `null` when the URL is
 * already right (so callers can skip the history write).
 */
export function railUrlFor(
  pathname: string,
  search: string,
  hash: string,
  state: RailUrlState,
): string | null {
  const current = new URLSearchParams(search);
  const next = applyRailParams(current, state);
  if (next.toString() === current.toString()) return null;
  const qs = next.toString();
  return `${pathname}${qs ? `?${qs}` : ""}${hash}`;
}
