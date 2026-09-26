"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { ExternalLink, PanelRightClose, Pin, PinOff } from "lucide-react";
import Link from "next/link";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button, buttonVariants } from "@/components/ui/button";
import { usePanelPin } from "@/hooks/use-panel-pin";
import {
  DEFAULT_PANEL_PIN,
  PANEL_MIN_MAIN,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
  type PanelPin,
} from "@/lib/panel-pin";
import { PANEL_WIDTH_PROPERTY, PanelResizeHandle } from "./panel-resize-handle";
import { usePanelContext } from "./panel-context";
import { ExperimentPanel } from "./experiment-panel";
import { OpportunityPanel } from "./opportunity-panel";
import { DiscoveryRailPanel } from "./discovery-rail-panel";
import { ObjectivePanel } from "./objective-panel";
import { KeyResultPanel } from "./key-result-panel";
import { SolutionPanel } from "./solution-panel";
import { AssumptionPanel } from "./assumption-panel";
import { RoadmapItemPanel } from "./roadmap-item-panel";
import { FeedbackPanel } from "./feedback-panel";
import { FeedbackComposer } from "@/components/feedback/feedback-composer";
import { OpportunityComposer } from "@/components/discovery/opportunity-composer";
import { isComposerPanelType } from "./composer-panel-types";
import { TaskDetail } from "@/components/tasks/task-detail";

const PANEL_TITLES: Record<string, string> = {
  objective: "Objective",
  keyResult: "Key Result",
  opportunity: "Opportunity",
  solution: "Solution",
  assumption: "Assumption",
  experiment: "Experiment",
  roadmapItem: "Roadmap Item",
  feedback: "Feedback",
  "feedback-new": "New feedback",
  "opportunity-new": "New opportunity",
  task: "Task",
  "discovery-rail": "Discovery",
};

/**
 * Upper bound on how long the deep-link panel waits for a browser idle period
 * after `load`. Short enough that a foreground deep link is indistinguishable
 * from opening immediately, long enough to let the idle callback win normally.
 */
const HYDRATION_DEADLINE_MS = 200;

/**
 * `useLayoutEffect` warns when a client component is server-rendered, and
 * PanelShell is — its pin state comes from a cookie the layout reads. See the
 * same pattern (and the fuller explanation) in `components/agent/agent-rail.tsx`.
 */
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface PanelShellProps {
  /**
   * Pin state read from the request cookie by the layout. Seeding this on the
   * server is the entire reason the preference is a cookie: it makes the very
   * first painted frame already correct for a pinned user, instead of showing
   * a modal overlay and swapping it for a column after hydration.
   *
   * Defaults to unpinned, which is also what an absent cookie parses to — so
   * a caller that has not been wired up yet gets exactly today's behaviour.
   */
  initialPin?: PanelPin;
}

export function PanelShell({ initialPin = DEFAULT_PANEL_PIN }: PanelShellProps = {}) {
  const { panel, closePanel, orgSlug, workspaceSlug, setDetailPanelDock } = usePanelContext();
  const [hydrated, setHydrated] = useState(false);
  const { pinned, width, viewportAllowsPin, isPinnedMode, togglePinned, commitWidth } = usePanelPin("detail", initialPin);
  const asideRef = useRef<HTMLElement | null>(null);
  const common = { orgSlug, workspaceSlug };

  // A composer (new feedback, new opportunity) always docks as a column on
  // wide screens, whatever the pin preference: the point of creating in a
  // panel is that the board stays visible and usable beside it. A modal
  // overlay would hide it.
  //
  // The docking then *sticks* for the rest of that panel session — through the
  // hand-off to the created item's detail view and any rows opened from the
  // grid afterwards — and ends when the panel closes. Without that, a submit
  // would visibly jump the new item from a column into a modal sheet for every
  // unpinned user. It is session state, never persisted: the saved pin
  // preference is untouched (see commitWidth in usePanelPin).
  const isComposer = isComposerPanelType(panel?.type);
  const [composerSession, setComposerSession] = useState(false);
  if (isComposer && !composerSession) setComposerSession(true);
  if (!panel && composerSession) setComposerSession(false);
  const docked = isPinnedMode || (viewportAllowsPin && (isComposer || composerSession));
  // `docked` alone isn't "is there an aside on screen claiming width right
  // now" — see the early return a few lines below the JSX split: `docked &&
  // !panel` renders nothing. Reporting that distinction up is what lets a
  // consumer (the agent rail) trust this value without also re-deriving
  // "is a panel even open" for itself.
  const actuallyDocked = docked && panel !== null;

  // The one and only writer of DetailPanelDock (see its doc comment in
  // panel-context.tsx for why this replaced watching the DOM for a
  // `[data-slot="pinned-panel"]` element).
  //
  // A *layout* effect, not a plain one: PanelShell and AgentRail are siblings,
  // and AgentRail reads `detailPanelDock` in its own layout effect to measure
  // before the browser paints. React flushes every layout effect in the tree
  // before any passive `useEffect` runs, but PanelShell is later in render
  // order than AgentRail (see the workspace layout), so on the very first
  // commit AgentRail's layout effect still runs before this one has had a
  // chance to report the real value. The `setDetailPanelDock` call below is
  // itself made from a layout effect, so React re-flushes layout effects
  // synchronously — including AgentRail's — before paint, correcting that
  // first read in the same tick. Were this a plain `useEffect` instead, the
  // correction would land one frame late: a rail whose cookie says open and a
  // detail panel already pinned via cookie would render docked for one frame,
  // wide enough to squeeze main content, before snapping to overlay.
  useIsomorphicLayoutEffect(() => {
    setDetailPanelDock?.({ docked: actuallyDocked, width });
  }, [actuallyDocked, width, setDetailPanelDock]);

  // A deep link is already present during SSR. Opening Base UI's modal Sheet
  // before hydration completes applies aria-hidden to the server-rendered
  // workspace tree before React compares it, producing a hydration mismatch.
  // Keep the controlled Sheet closed for the identical server/first-client
  // render, then honor the URL immediately after hydration.
  //
  // This gate is deliberately applied to the OVERLAY branch only. A pinned
  // panel is not a modal: it sets no aria-hidden on anything, so it can honour
  // a deep link on the first paint, and gating it would reintroduce exactly
  // the flash the server-seeded pin state exists to prevent.
  useEffect(() => {
    // Parent layout effects can run while a streamed page Suspense subtree is
    // still hydrating. Wait for the document load boundary and the browser's
    // next idle period before the modal applies aria-hidden to its siblings.
    // This is tied to hydration-relevant browser state, not a timing guess.
    //
    // The `load` event is the boundary that actually carries the correctness
    // property, and it fires regardless of tab visibility — so it is kept.
    // The idle callback is only a refinement on top of it, and refinements
    // must not be able to block the panel forever: requestIdleCallback (and
    // requestAnimationFrame, the old fallback) are deferred indefinitely in a
    // backgrounded tab, and rIC's own `timeout` is not reliably honored there
    // either. A `?detail=…` deep link opened in a background tab therefore
    // rendered no panel at all, even with readyState already "complete".
    //
    // So: still prefer idle, but race it against a plain timer, which is the
    // one scheduler a background tab always runs (throttled, never dropped).
    // Whichever wins, setHydrated(true) is idempotent. A plain
    // useEffect(() => setHydrated(true), []) would also be reliable, but it
    // discards the post-load/idle wait that keeps the modal from applying
    // aria-hidden to a sibling subtree that is still hydrating.
    let idleId: number | undefined;
    let timerId: number | undefined;
    const activate = () => setHydrated(true);
    const scheduleActivation = () => {
      if (typeof window.requestIdleCallback === "function") {
        idleId = window.requestIdleCallback(activate, {
          timeout: HYDRATION_DEADLINE_MS,
        });
      }
      timerId = window.setTimeout(activate, HYDRATION_DEADLINE_MS);
    };

    if (document.readyState === "complete") scheduleActivation();
    else window.addEventListener("load", scheduleActivation, { once: true });

    return () => {
      window.removeEventListener("load", scheduleActivation);
      if (idleId !== undefined) window.cancelIdleCallback(idleId);
      if (timerId !== undefined) window.clearTimeout(timerId);
    };
  }, []);

  /**
   * The gesture's upper bound, measured from the live layout rather than
   * assumed: whatever room main content has beyond PANEL_MIN_MAIN is room the
   * panel may take. Measuring it also means the bound already accounts for the
   * sidebar's current width, whether it is expanded or collapsed to icons,
   * without this component knowing anything about the sidebar.
   *
   * Main content is found by its `data-slot`, not by `previousElementSibling`.
   * The aside is rendered immediately after SidebarInset today, but that is a
   * layout detail two files away; if anything is ever inserted between them,
   * a sibling lookup would silently start measuring the wrong element and
   * clamp every drag to the minimum, with nothing to catch it.
   */
  const resolveMaxWidth = useCallback(() => {
    const main = asideRef.current?.parentElement?.querySelector(
      '[data-slot="sidebar-inset"]',
    );
    // Unmeasurable falls back to the absolute maximum rather than to the
    // current width. Freezing the gesture is the worse failure — the panel
    // would silently refuse to grow — and the CSS clamp still protects main
    // content either way.
    if (!(main instanceof HTMLElement)) return PANEL_WIDTH_MAX;
    const slack = main.getBoundingClientRect().width - PANEL_MIN_MAIN;
    return Math.max(PANEL_WIDTH_MIN, width + slack);
  }, [width]);

  // In pinned mode there is no dialog and no focus trap, so Esc has to be
  // handled here. React's synthetic bubbling scopes this to events that
  // originated inside the aside — a user typing Esc in a main-content field
  // must not close a column they deliberately docked. Deliberately no
  // stopPropagation: Base UI's Select and Popover already swallow Esc at their
  // own popup, so "Esc closes the select, second Esc closes the panel" falls
  // out for free.
  const handleAsideKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    // React bubbles events through portals, so an Esc inside a dialog opened
    // *from* this panel (the composer's discard confirmation) would otherwise
    // close the panel underneath it too. Only Esc from the aside's own DOM.
    if (!(event.target instanceof Node) || !asideRef.current?.contains(event.target)) return;
    closePanel();
  };

  const title = panel ? PANEL_TITLES[panel.type] ?? panel.type : "";
  const fullPageRoute = panel?.type === "task" ? "tasks" : panel?.type === "opportunity" ? "discovery" : null;
  const hasCompactHeader = fullPageRoute !== null;
  const fullPageAction = fullPageRoute && panel ? (
    <Link
      className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
      href={`/${orgSlug}/${workspaceSlug}/${fullPageRoute}/${panel.id}`}
      aria-label="Open full page"
      title="Open full page"
    >
      <ExternalLink aria-hidden />
    </Link>
  ) : null;

  const body = (
    <>
      {panel?.type === "objective" && <ObjectivePanel id={panel.id} {...common} />}
      {panel?.type === "keyResult" && <KeyResultPanel id={panel.id} {...common} />}
      {panel?.type === "opportunity" && (
        <OpportunityPanel opportunityId={panel.id} {...common} />
      )}
      {panel?.type === "solution" && <SolutionPanel id={panel.id} {...common} />}
      {panel?.type === "assumption" && <AssumptionPanel id={panel.id} {...common} />}
      {panel?.type === "experiment" && (
        <ExperimentPanel experimentId={panel.id} {...common} />
      )}
      {panel?.type === "roadmapItem" && <RoadmapItemPanel id={panel.id} {...common} />}
      {panel?.type === "feedback" && <FeedbackPanel id={panel.id} {...common} />}
      {panel?.type === "feedback-new" && <FeedbackComposer {...common} />}
      {panel?.type === "opportunity-new" && <OpportunityComposer composerId={panel.id} {...common} />}
      {panel?.type === "task" && (
        <TaskDetail taskId={panel.id} variant="panel" {...common} />
      )}
      {panel?.type === "discovery-rail" && (
        <DiscoveryRailPanel activeOpportunityId={panel.id} {...common} />
      )}
    </>
  );

  const pinToggle = (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={togglePinned}
      // "Pin panel" / "Unpin panel" avoid the strings Comment, Reply, Resolve,
      // Restore and Show resolved, all of which existing specs match on with
      // getByRole("button", { name }) inside this panel.
      aria-label={pinned ? "Unpin panel" : "Pin panel"}
      title={pinned ? "Unpin panel" : "Pin panel"}
      aria-pressed={pinned}
      data-slot="panel-pin-toggle"
    >
      {pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
    </Button>
  );

  // The composer owns its own scrolling (a body that fills the height and a
  // sticky footer), so it gets a bare flex column instead of the padded,
  // scrolling body every entity panel shares.
  const bodyClassName = isComposer
    ? "flex min-h-0 flex-1 flex-col"
    : `flex-1 overflow-y-auto ${hasCompactHeader ? "pt-3" : "pt-4"}`;

  const escHint = isComposer ? (
    <kbd className="hidden rounded border border-border-default bg-surface-inset px-1.5 py-0.5 font-sans text-[10px] font-medium text-text-subtle sm:inline-block" title="Press Esc to close — your draft is kept">
      Esc
    </kbd>
  ) : null;

  if (docked) {
    if (!panel) return null;

    return (
      <aside
        ref={asideRef}
        data-slot="pinned-panel"
        data-panel-id="detail"
        onKeyDown={handleAsideKeyDown}
        // `hidden lg:flex` is the CSS gate, and `lg` is 1024px — the same
        // number as PANEL_PIN_MIN_VIEWPORT, by construction. This is what makes
        // seeding the media query with the pin preference safe: if the guess is
        // wrong, this paints nothing at all rather than painting a pinned panel
        // on a viewport too narrow to hold one.
        //
        // `shrink-0` keeps the aside from being squeezed, but on its own it is
        // not enough: the sidebar's invisible gap element has no shrink-0, so
        // an over-wide aside would shrink *that* instead and let the fixed
        // sidebar overlap main content. The width clamp and the 1024px gate are
        // what actually prevent it.
        className="panel-pinned-surface relative hidden shrink-0 min-h-0 flex-col overflow-hidden border-l border-border-default bg-surface-panel lg:flex print:hidden"
        // React diffs this against the *previous props*, not against the DOM,
        // so a re-render mid-drag (when the DOM property has raced ahead) sees
        // no change and performs no write. That is what lets the drag be
        // imperative and still survive a parent re-render.
        style={{ [PANEL_WIDTH_PROPERTY]: `${width}px` } as CSSProperties}
      >
        <PanelResizeHandle
          width={width}
          surfaceRef={asideRef}
          resolveMaxWidth={resolveMaxWidth}
          onCommit={commitWidth}
        />

        <div className={`flex shrink-0 items-center justify-between gap-2 border-b px-5 ${hasCompactHeader ? "py-1.5" : "py-3"}`}>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </h2>
          <div className="flex items-center gap-1">
            {fullPageAction}
            {escHint}
            {!isComposer && pinToggle}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={closePanel}
              aria-label="Close panel"
              title="Close panel"
            >
              <PanelRightClose aria-hidden />
            </Button>
          </div>
        </div>

        <div className={bodyClassName}>{body}</div>
      </aside>
    );
  }

  return (
    <Sheet open={hydrated && panel !== null} onOpenChange={(open) => { if (!open) closePanel(); }}>
      <SheetContent
        side="right"
        // z-[60] is the panel layer — see the stacking-layer ladder in
        // app/globals.css. Overlays opened from inside this panel (dialogs at
        // 70, popups at 80) are laddered above it; anything portalled at 50
        // would paint underneath and refuse mouse clicks.
        //
        // Note: never pass `data-slot` here. SheetContent spreads {...props}
        // last, so it would silently replace `sheet-content` — the attribute
        // ~21 functional specs locate this panel by.
        className={`w-full ${isComposer ? "sm:max-w-xl" : "sm:max-w-md"} flex flex-col gap-0 p-0 z-[60]`}
        showCloseButton={!hasCompactHeader}
      >
        <SheetHeader className={hasCompactHeader ? "px-5 py-1.5 shrink-0 border-b" : "px-5 pt-5 pb-3 shrink-0 border-b"}>
          <div className={`flex items-center justify-between gap-2 ${hasCompactHeader ? "" : "pr-8"}`}>
            <SheetTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              {title}
            </SheetTitle>
            {/* The only discoverable way to pin *from* the overlay. Hidden
                below lg because pinning is suspended there anyway — offering a
                control that visibly does nothing is worse than not offering
                it. */}
            <div className="flex items-center gap-1">
              {fullPageAction}
              {escHint}
              {!isComposer && <div className="hidden lg:flex items-center">{pinToggle}</div>}
              {hasCompactHeader && (
                <Button variant="ghost" size="icon-sm" onClick={closePanel} aria-label="Close panel" title="Close panel">
                  <PanelRightClose aria-hidden />
                </Button>
              )}
            </div>
          </div>
        </SheetHeader>

        <div className={bodyClassName}>{body}</div>
      </SheetContent>
    </Sheet>
  );
}
