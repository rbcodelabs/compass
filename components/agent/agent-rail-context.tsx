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
import { usePathname } from "next/navigation";

import {
  DEFAULT_PANEL_PIN,
  clampPanelWidth,
  panelPinCookieString,
  type PanelPin,
} from "@/lib/panel-pin";

/**
 * Open/close + active-thread state for the agent rail.
 *
 * ## Why this is not a URL search param, when every detail panel is
 *
 * `PanelProvider` keeps the open detail panel in `?detail=<type>:<id>`, and for
 * that panel it is the right call: the panel is *about* a thing on the current
 * page, so it should be shareable, survive a refresh, and close on Back.
 *
 * The rail is the opposite kind of object. Its whole reason for existing is to
 * stay put while the user moves around the workspace — the agent is mid-turn,
 * streaming, and navigating to the Roadmap must not interrupt it. A search
 * param cannot express that: every `<Link>` in the sidebar builds a fresh URL
 * with no `?agent=`, so the first navigation would drop the param and close the
 * rail. Worse, it would be a *remount*, which aborts the in-flight
 * `EventSource`/fetch stream and loses the transcript of the current turn.
 *
 * So the open flag is React state in a provider mounted in the workspace
 * layout. The layout does not re-render across sibling route changes, so the
 * state — and the streaming DOM under it — survives navigation. The cost is
 * that rail state is not shareable via URL, which is correct: "my agent chat is
 * open" is not a property of the page you are looking at.
 *
 * Refresh persistence is handled by the `compass_panel_agent` cookie instead,
 * which the layout reads server-side so the first painted frame is already
 * correct. See the `"agent"` entry in lib/panel-pin.ts for why that cookie's
 * `pinned` bit means "docked open" here.
 *
 * ## The active conversation is also client state, and deliberately decoupled
 *
 * The full page selects a conversation with `?c=<id>` and server-loads it. The
 * rail cannot reuse that: changing the URL is the navigation this whole design
 * exists to avoid. So the rail owns `conversationId` locally and fetches
 * through the `/api/agent/conversations` routes.
 *
 * The two surfaces therefore hold the active thread in different places, which
 * is fine as long as the handoff between them is explicit: "expand to full
 * page" reads this value and puts it in the URL it navigates to.
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

/** The views the rail can show. Add an id here and a row in VIEWS (agent-rail.tsx) to add one. */
export type RailView = "agent" | "help" | "library";

/** A one-shot request for the Help view to show something. `id` makes repeats distinct. */
export type DocsIntent = { id: number; slug?: string; anchor?: string; query?: string };

/**
 * A one-shot "ask the agent about this" hand-off from the Help view.
 *
 * Display-only context: unlike the Send-to-agent `seedEntity` (which names a
 * Compass entity the server resolves), a docs article is not an entity, so the
 * chip here is a labelled link and the question itself travels in `text`,
 * which prefills the composer. Nothing is sent until the user sends it.
 */
export type AgentSeed = { id: number; label: string; summary: string; sourceUrl: string; text: string };

type AgentRailContextValue = {
  /** Which view the rail shows. Switching never unmounts the chat. */
  view: RailView;
  setView: (view: RailView) => void;
  docsIntent: DocsIntent | null;
  /** Open the rail on the Help view, optionally straight to an article or a search. */
  openDocs: (options?: { slug?: string; anchor?: string; query?: string }) => void;
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
}: {
  children: React.ReactNode;
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
  const [wantsOpen, setOpen] = useState(initialPin.pinned);
  const available = !isAgentPagePath(usePathname());
  const open = available && wantsOpen;
  const [width, setWidth] = useState(() => clampPanelWidth(initialPin.width));
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [view, setView] = useState<RailView>("agent");
  const [docsIntent, setDocsIntent] = useState<DocsIntent | null>(null);
  const [agentSeed, setAgentSeed] = useState<AgentSeed | null>(null);
  const intentCounter = useRef(0);

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
      openDocs,
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
      openDocs,
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
