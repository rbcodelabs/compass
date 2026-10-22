"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname, useSearchParams } from "next/navigation";

import {
  DEFAULT_PANEL_PIN,
  clampPanelWidth,
  panelPinCookieString,
  type PanelPin,
} from "@/lib/panel-pin";
import {
  decodeConversationId,
  decodeRailParams,
  railUrlFor,
  type HelpArticleRef,
  type RailView,
} from "@/lib/agent-rail-url";

/**
 * Open/close + active-thread state for the agent rail, mirrored into the URL.
 *
 * ## React state is the source of truth; the URL is a mirror of it
 *
 * The rail exists to stay put while the user moves around the workspace: the
 * agent is mid-turn, streaming, and navigating to the Roadmap must not
 * interrupt it. So the state lives in React, in a provider mounted in the
 * workspace layout. The layout does not re-render across sibling route changes,
 * so the state - and the streaming DOM under it - survives navigation.
 *
 * What the rail shows is *also* written to the URL (params in
 * lib/agent-rail-url.ts), so a refresh restores it and a link shares it. That
 * is done without involving the router:
 *
 *  - **Writes use `window.history.replaceState`.** Next's app router patches the
 *    native history methods and feeds them into `usePathname`/`useSearchParams`,
 *    so nothing is fetched, nothing navigates and nothing remounts. A real
 *    `router.push`/`replace` is a navigation, and a remount would abort the
 *    in-flight stream - the one thing this design must never do. `replace`
 *    rather than `push` because switching rail views is not a place the Back
 *    button should return to.
 *  - **Reads happen once, at mount.** The provider seeds `view`,
 *    `conversationId` and the open Help article from the URL, and a valid rail
 *    param also opens the rail for someone whose cookie says it is closed.
 *    After that the URL never drives the state, so a stray navigation cannot
 *    swap the thread under a streaming turn.
 *  - **In-app navigation re-applies the params.** Sidebar `<Link>`s and
 *    `router.push` calls build fresh URLs that carry no rail params. Rather than
 *    patch every call site, an effect re-mirrors the rail state onto whatever
 *    URL the router lands on. Params are only added and removed by name, so
 *    `?detail=` and page filters compose untouched.
 *
 * Open/closed itself stays the `compass_panel_agent` cookie (see the `"agent"`
 * entry in lib/panel-pin.ts for why its `pinned` bit means "docked open"), read
 * by the layout so the first painted frame is already right. A closed rail
 * writes no params; the URL can open the rail but never close it.
 *
 * ## The active conversation and the full page
 *
 * The full page selects a conversation with `?c=<id>`, server-loaded. The rail
 * owns `conversationId` in state and fetches through `/api/agent/conversations`,
 * mirrored as `?rc=<id>`. The two interoperate: "expand to full page" puts the
 * rail's id in `c`, and while the page is showing (where the rail is hidden and
 * its params are not written) `c` is adopted back into `conversationId`, so
 * leaving the page and reopening the rail lands on the same thread. An id the
 * viewer cannot read 404s from the messages route and shows as an empty thread,
 * the same as on the page.
 */

const AGENT_RAIL_SHORTCUT = "j";

/**
 * Whether `pathname` is the full-page agent screen,
 * `/[orgSlug]/[workspaceSlug]/agent` (or anything under it).
 *
 * The rail is unavailable there. That page already runs its own live
 * `AgentChat`, and two chats over one conversation means two streams writing
 * one thread. Matched on the whole third segment, so a sibling route whose
 * name merely starts with "agent" is not caught by it.
 */
export function isAgentPagePath(pathname: string | null): boolean {
  if (!pathname) return false;
  const segments = pathname.split("/").filter(Boolean);
  return segments[2] === "agent";
}

// Defined in lib/agent-rail-url.ts. Add an id there and a row in VIEWS (agent-rail.tsx) to add a view.
export type { RailView };

/** A one-shot request for the Help view to show something. `id` makes repeats distinct. */
export type DocsIntent = { id: number; slug?: string; anchor?: string; query?: string };

/**
 * A one-shot "ask the agent about this" hand-off from the Help view.
 *
 * Display-only context: unlike the Send-to-agent `seedEntity` (which names a
 * Compass entity the server resolves), a docs article is not an entity, so the
 * chip here is a labelled link and the question itself travels in `text`,
 * which prefills the composer. Nothing is sent until the user sends it.
 * The chip is optional: omit `label`/`sourceUrl` (the Cmd+K palette's plain
 * questions do) and only the composer is prefilled.
 */
export type AgentSeed = { id: number; label?: string; summary?: string; sourceUrl?: string; text: string };

type AgentRailContextValue = {
  /** Which view the rail shows. Switching never unmounts the chat. */
  view: RailView;
  setView: (view: RailView) => void;
  docsIntent: DocsIntent | null;
  /** The Help article currently open in the rail, for mirroring into the URL. */
  helpArticle: HelpArticleRef | null;
  /** Called by the Help view when it opens or closes an article. */
  reportHelpArticle: (article: HelpArticleRef | null) => void;
  /** Open the rail on the Help view, optionally straight to an article or a search. */
  openDocs: (options?: { slug?: string; anchor?: string; query?: string }) => void;
  /**
   * The workspace this rail serves. Lets other surfaces (the Cmd+K palette's
   * inline ask) start agent turns without being told the id separately.
   */
  workspaceId: string | null;
  /** Open the rail on the Library view (the Docs tree). */
  openLibrary: () => void;
  agentSeed: AgentSeed | null;
  /** Switch to the Agent view with a context chip and a prefilled, unsent composer. */
  askAgent: (seed: Omit<AgentSeed, "id">) => void;
  /** Called by the chat once it has applied a seed, so a later remount cannot replay it. */
  clearAgentSeed: () => void;
  /**
   * Whether the rail is docked open. Not whether it is currently a column — see
   * AgentRail for the space-driven overlay demote. Always `false` on the
   * full-page agent screen (see `available`), whatever the saved preference.
   */
  open: boolean;
  /**
   * `false` on the full-page agent screen, where the rail is hidden and cannot
   * be toggled. The saved preference is left alone, so the rail comes back as
   * it was on the next screen.
   */
  available: boolean;
  /** Open the rail, optionally jumping straight to a thread (or `null` for a fresh chat). */
  openRail: (options?: { conversationId?: string | null }) => void;
  closeRail: () => void;
  toggleRail: () => void;
  /** `null` means "a new, unsaved chat". */
  conversationId: string | null;
  selectConversation: (id: string | null) => void;
  width: number;
  commitWidth: (width: number) => void;
};

const AgentRailContext = createContext<AgentRailContextValue | null>(null);

export function AgentRailProvider({
  children,
  initialPin = DEFAULT_PANEL_PIN,
  workspaceId = null,
}: {
  children: React.ReactNode;
  workspaceId?: string | null;
  /**
   * Read from the `compass_panel_agent` cookie by the workspace layout. Seeding
   * on the server is what keeps a returning user from watching the rail pop in
   * after hydration.
   */
  initialPin?: PanelPin;
}) {
  // `wantsOpen` is the user's preference; `open` is what is actually shown.
  // Kept apart so visiting the agent page hides the rail without rewriting the
  // preference, which would otherwise close it on every screen afterwards.
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Read once: the URL seeds the state at mount and never drives it afterwards.
  const [fromUrl] = useState(() => decodeRailParams(searchParams));
  const [wantsOpen, setOpen] = useState(fromUrl?.open ?? initialPin.pinned);
  const available = !isAgentPagePath(pathname);
  const open = available && wantsOpen;
  const [width, setWidth] = useState(() => clampPanelWidth(initialPin.width));
  const [conversationId, setConversationId] = useState<string | null>(fromUrl?.conversationId ?? null);
  const [view, setView] = useState<RailView>(fromUrl?.view ?? "agent");
  // A restored article is handed to the Help view as an ordinary one-shot intent.
  const [docsIntent, setDocsIntent] = useState<DocsIntent | null>(
    fromUrl?.helpArticle ? { id: 1, ...fromUrl.helpArticle } : null,
  );
  const [helpArticle, setHelpArticle] = useState<HelpArticleRef | null>(fromUrl?.helpArticle ?? null);
  const [agentSeed, setAgentSeed] = useState<AgentSeed | null>(null);
  const intentCounter = useRef(fromUrl?.helpArticle ? 1 : 0);

  // Written from event handlers only, never in render and never in a mount
  // effect — the same discipline PanelShell documents. A write during mount
  // would race the server-seeded value it was derived from.
  const persist = useCallback((next: PanelPin) => {
    document.cookie = panelPinCookieString("agent", next);
  }, []);

  const openRail = useCallback(
    (options?: { conversationId?: string | null }) => {
      if (!available) return;
      if (options && "conversationId" in options) {
        setConversationId(options.conversationId ?? null);
      }
      setOpen(true);
      persist({ pinned: true, width });
    },
    [available, persist, width],
  );

  const closeRail = useCallback(() => {
    setOpen(false);
    persist({ pinned: false, width });
  }, [persist, width]);

  const toggleRail = useCallback(() => {
    if (!available) return;
    // Computed outside the updater: updaters must stay pure, and StrictMode
    // double-invokes them in development.
    const next = !open;
    setOpen(next);
    persist({ pinned: next, width });
  }, [available, open, persist, width]);

  const commitWidth = useCallback(
    (next: number) => {
      const clamped = clampPanelWidth(next);
      setWidth(clamped);
      persist({ pinned: true, width: clamped });
      // Same reason PanelShell does this: a few widgets (the roadmap Gantt most
      // of all) measure their container once and cache it, and the rail
      // resizing changes main content's width without any window resize.
      window.dispatchEvent(new Event("resize"));
    },
    [persist],
  );

  const openDocs = useCallback(
    (options?: { slug?: string; anchor?: string; query?: string }) => {
      if (!available) return;
      intentCounter.current += 1;
      setDocsIntent({ id: intentCounter.current, ...options });
      setView("help");
      setOpen(true);
      persist({ pinned: true, width });
    },
    [available, persist, width],
  );

  const openLibrary = useCallback(() => {
    if (!available) return;
    setView("library");
    setOpen(true);
    persist({ pinned: true, width });
  }, [available, persist, width]);

  const askAgent = useCallback(
    (seed: Omit<AgentSeed, "id">) => {
      if (!available) return;
      intentCounter.current += 1;
      setAgentSeed({ id: intentCounter.current, ...seed });
      setView("agent");
      setOpen(true);
      persist({ pinned: true, width });
    },
    [available, persist, width],
  );

  const clearAgentSeed = useCallback(() => setAgentSeed(null), []);

  const selectConversation = useCallback((id: string | null) => {
    setConversationId(id);
  }, []);

  const reportHelpArticle = useCallback((article: HelpArticleRef | null) => {
    setHelpArticle(article);
  }, []);

  // Mirror the rail into the URL. Runs on every route/param change too, which is
  // what re-applies the params after a sidebar link or router push replaced the
  // URL with one that has none. `searchParams` is a dependency only as the
  // trigger: the write reads `window.location`, the freshest copy, and is
  // skipped when the URL is already right, so the replaceState -> searchParams
  // update it causes settles on the next pass instead of looping.
  // Not on the agent page: the rail is hidden there and `?c=` owns the thread.
  useEffect(() => {
    if (!available) return;
    const href = railUrlFor(window.location.pathname, window.location.search, window.location.hash, {
      open,
      view,
      conversationId,
      helpArticle,
    });
    if (href) window.history.replaceState(null, "", href);
  }, [available, open, view, conversationId, helpArticle, pathname, searchParams]);

  // The full page's `?c=` is the same thread the rail would show; adopt it so
  // leaving the page and reopening the rail is lossless.
  const pageConversation = decodeConversationId(searchParams.get("c"));
  // Adjusted during render (React's "derive state from props" pattern) rather
  // than in an effect, so the rail never paints a frame on the stale thread.
  const adoptKey = available ? "off" : (pageConversation ?? "new");
  const [adoptedKey, setAdoptedKey] = useState("off");
  if (adoptKey !== adoptedKey) {
    setAdoptedKey(adoptKey);
    if (!available) setConversationId(pageConversation);
  }

  // Cmd/Ctrl+J. Cmd+K is the workspace search palette and Cmd+B is the
  // sidebar, so J is the first unclaimed key in that family.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== AGENT_RAIL_SHORTCUT ||
        (!event.metaKey && !event.ctrlKey) ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      // Left to the browser on the agent page, where there is no rail to toggle.
      if (!available) return;
      event.preventDefault();
      // A held chord auto-repeats; toggling on each repeat would flap the rail
      // and unmount the chat (aborting its turn) on every other one. Still
      // preventDefault'ed above so the repeats do not reach the browser either.
      if (event.repeat) return;
      toggleRail();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [available, toggleRail]);

  // "?" opens Docs, unless the user is typing somewhere. ("/" is deliberately
  // not bound: the workspace gallery already owns it.)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "?" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.defaultPrevented || !available) return;
      const el = event.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      event.preventDefault();
      openDocs();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [available, openDocs]);

  const value = useMemo(
    () => ({
      view,
      setView,
      docsIntent,
      helpArticle,
      reportHelpArticle,
      openDocs,
      workspaceId,
      openLibrary,
      agentSeed,
      askAgent,
      clearAgentSeed,
      open,
      available,
      openRail,
      closeRail,
      toggleRail,
      conversationId,
      selectConversation,
      width,
      commitWidth,
    }),
    [
      view,
      docsIntent,
      helpArticle,
      reportHelpArticle,
      openDocs,
      workspaceId,
      openLibrary,
      agentSeed,
      askAgent,
      clearAgentSeed,
      open,
      available,
      openRail,
      closeRail,
      toggleRail,
      conversationId,
      selectConversation,
      width,
      commitWidth,
    ],
  );

  return <AgentRailContext.Provider value={value}>{children}</AgentRailContext.Provider>;
}

export function useAgentRail() {
  const ctx = useContext(AgentRailContext);
  if (!ctx) throw new Error("useAgentRail must be used inside AgentRailProvider");
  return ctx;
}

/**
 * Non-throwing variant, for components that render both inside and outside a
 * workspace (the sidebar is used by the settings tree too, which has no rail).
 */
export function useAgentRailOptional() {
  return useContext(AgentRailContext);
}
