"use client"

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import type { CSSProperties, KeyboardEvent } from "react"
import { useRouter } from "next/navigation"
import { Maximize2, MessagesSquare, Plus, Sparkles, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { PANEL_MIN_MAIN, PANEL_WIDTH_MAX, PANEL_WIDTH_MIN } from "@/lib/panel-pin"
import {
  PANEL_WIDTH_PROPERTY,
  PanelResizeHandle,
} from "@/components/panels/panel-resize-handle"
import { usePanelContext } from "@/components/panels/panel-context"
import { AgentChat } from "@/components/agent/agent-chat"
import { useAgentRail } from "@/components/agent/agent-rail-context"

/**
 * The agent chat, docked as a column to the left of main content.
 *
 * ## Why a left column and not a second right-hand panel
 *
 * The right rail is already the entity detail panel, and that panel is the thing
 * a user is most often consulting *while* talking to the agent — so putting the
 * agent there would force a choice between the two. The agent goes on the left
 * instead, beside the nav, and the detail panel never moves. Everywhere below
 * that a width has to give, the rail is what yields.
 *
 * ## Docked vs overlay is arithmetic, not a preference
 *
 * Four columns want the viewport at once: nav (220px expanded), this rail
 * (320px minimum), main content (PANEL_MIN_MAIN = 480px), and the detail panel
 * (448px by default). That totals 1468px. A 1440px laptop with a detail panel
 * open therefore *cannot* show a docked rail without pushing main content below
 * its floor — this is the common case, not an edge case.
 *
 * So when the measured leftover is under PANEL_WIDTH_MIN the rail renders as a
 * non-modal overlay drawer over main content instead of as a column. Two things
 * about that are deliberate:
 *
 *  - **It is the same element in both modes**, differing only in positioning
 *    classes. Swapping between two rendered branches would unmount `AgentChat`,
 *    whose cleanup aborts the in-flight turn — the exact interruption this whole
 *    feature exists to remove. A window resize past the threshold must not kill
 *    a streaming response.
 *  - **It is not a modal.** No backdrop, no focus trap, no `aria-hidden` on the
 *    rest of the app. The detail panel stays visible and clickable underneath,
 *    which is the constraint that chose the left side in the first place.
 */

type RailMessage = { id: string; role: "user" | "assistant"; content: string }
type RailThread = { id: string; title: string | null }

/**
 * A new chat's transcript, as a stable reference.
 *
 * `AgentChat` re-seeds its transcript whenever `initialMessages` changes
 * *identity*, so a fresh `[]` per render would wipe the thread on every parent
 * re-render — and this parent re-renders on every drag commit and every detail
 * panel change. Module scope makes the identity constant for the process.
 *
 * Deliberately not `Object.freeze`d: that types it `readonly RailMessage[]`,
 * which `AgentChat`'s mutable `initialMessages` rejects. Nothing here mutates it
 * — every code path replaces the reference rather than pushing into it.
 */
const NO_MESSAGES: RailMessage[] = [];

/**
 * `AgentMessage.role` is a plain `VarChar(20)` in the schema, documented as
 * `"user" | "assistant"` but not constrained to it, so it is narrowed on arrival
 * exactly as the agent page narrows its own server-loaded rows. Anything
 * unrecognised reads as a user message, which is the safe direction: it can only
 * ever mislabel a message as the human's, never attribute one to the agent.
 */
function toRailMessages(raw: unknown): RailMessage[] {
  if (!Array.isArray(raw)) return NO_MESSAGES
  return raw.flatMap((row) => {
    if (!row || typeof row !== "object") return []
    const { id, role, content } = row as Record<string, unknown>
    if (typeof id !== "string" || typeof content !== "string") return []
    return [{ id, content, role: role === "assistant" ? ("assistant" as const) : ("user" as const) }]
  })
}

/** Room for the rail, in px, or `null` while unmeasured. */
type Measurement = { available: number; navOffset: number };

/**
 * `useLayoutEffect` warns when a client component is server-rendered, and the
 * rail is: its open state comes from a cookie the layout reads. The measurement
 * has to happen before paint (see the flash note in `useMeasurement`), so the
 * hook is chosen per environment rather than downgraded everywhere.
 */
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * How much horizontal room is left for the rail, and where its left edge sits.
 *
 * Every term is read from an element whose width does not depend on the rail's
 * own, so this cannot feed back into itself:
 *
 *  - the wrapper is `w-full`, so its width is the viewport's;
 *  - `sidebar-gap` is the sidebar's *in-flow* spacer, so it reports the nav's
 *    live width — icon or expanded — without this component knowing either
 *    number, and it is the element that animates, so observing it tracks a
 *    collapse through its 200ms transition rather than sampling it once;
 *  - `pinned-panel` is the docked detail panel, absent from the DOM when there
 *    isn't one.
 */
function measure(rail: HTMLElement | null): Measurement | null {
  const wrapper = rail?.closest('[data-slot="sidebar-wrapper"]')
  if (!(wrapper instanceof HTMLElement)) return null

  const gap = wrapper.querySelector('[data-slot="sidebar-gap"]')
  const detail = wrapper.querySelector('[data-slot="pinned-panel"]')
  // Absent rather than zero-width on mobile: the sidebar renders as a sheet
  // there and contributes no in-flow spacer at all, so an overlay rail starts
  // at the left edge. That is the correct mobile layout, not a fallback.
  const navOffset = gap instanceof HTMLElement ? gap.getBoundingClientRect().width : 0
  const detailWidth =
    detail instanceof HTMLElement ? detail.getBoundingClientRect().width : 0

  return {
    navOffset,
    available: Math.floor(
      wrapper.getBoundingClientRect().width - navOffset - detailWidth - PANEL_MIN_MAIN,
    ),
  }
}

function useMeasurement(
  railRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  // Re-binds the observers when the detail panel mounts or unmounts, since that
  // is a different element rather than a resize of an existing one.
  detailPanelKey: string | null,
) {
  const [measurement, setMeasurement] = useState<Measurement | null>(null)

  // Before paint, not after: a returning user whose cookie says the rail was
  // open, on a viewport too narrow to dock it, would otherwise see one frame of
  // a squeezed layout before the overlay took over.
  useIsomorphicLayoutEffect(() => {
    if (!enabled) return
    const rail = railRef.current
    const wrapper = rail?.closest('[data-slot="sidebar-wrapper"]')
    if (!(wrapper instanceof HTMLElement)) return

    const update = () => setMeasurement(measure(rail))
    update()

    // Observing the wrapper covers window resize (it is `w-full`), which is why
    // there is no resize listener here. jsdom has no ResizeObserver and several
    // specs render this tree, so the one-shot measurement above has to be
    // enough on its own when the constructor is missing.
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update)
    const observeSizes = () => {
      if (!resizeObserver) return
      resizeObserver.disconnect()
      resizeObserver.observe(wrapper)
      for (const selector of ['[data-slot="sidebar-gap"]', '[data-slot="pinned-panel"]']) {
        const element = wrapper.querySelector(selector)
        if (element instanceof HTMLElement) resizeObserver.observe(element)
      }
    }
    observeSizes()

    // The detail panel column can appear or vanish with no change to
    // `detailPanelKey`: PanelShell's "Pin panel" swaps the *same* panel from a
    // portaled Sheet to an in-flow `pinned-panel` aside (and back) without
    // touching `?detail=`, and crossing the 1024px pin threshold does the same.
    // Watching the wrapper's direct children catches every one of those, from
    // the DOM this function already measures, rather than mirroring PanelShell's
    // internal pin state into shared context. Direct children only: the aside
    // is a sibling of main content, so there is no need to see into the page.
    const mutationObserver = new MutationObserver((records) => {
      const detailPanelChanged = records.some((record) =>
        [...record.addedNodes, ...record.removedNodes].some(
          (node) => node instanceof HTMLElement && node.dataset.slot === "pinned-panel",
        ),
      )
      if (!detailPanelChanged) return
      observeSizes()
      update()
    })
    mutationObserver.observe(wrapper, { childList: true })

    return () => {
      resizeObserver?.disconnect()
      mutationObserver.disconnect()
    }
  }, [enabled, detailPanelKey, railRef])

  return measurement
}

export interface AgentRailProps {
  workspaceId: string
  /** `/${orgSlug}/${workspaceSlug}` — matches AgentChat's prop of the same name. */
  basePath: string
  userInitials: string
}

export function AgentRail({ workspaceId, basePath, userInitials }: AgentRailProps) {
  const {
    open,
    closeRail,
    conversationId,
    selectConversation,
    width,
    commitWidth,
  } = useAgentRail()
  // Only to know *whether* a detail panel is docked; the rail never reads or
  // changes its contents. Its width is measured, not derived from this.
  const { panel } = usePanelContext()
  const router = useRouter()
  const railRef = useRef<HTMLElement | null>(null)

  const [threads, setThreads] = useState<RailThread[]>([])
  // Stored *with* the id it was loaded for, and read back through that id
  // below. Keeping them in separate pieces of state lets a thread switch put
  // one thread's transcript on screen under another thread's id for as long as
  // the fetch takes — which, for a transcript being handed to a chat component
  // as its seed, is not a cosmetic flicker.
  const [loaded, setLoaded] = useState<{ conversationId: string; messages: RailMessage[] } | null>(
    null,
  )
  // Ids adopted from a turn that just finished streaming in this rail. Their
  // transcript is already on screen, so refetching it would be a wasted request
  // whose only visible effect is a flicker.
  //
  // Consumed once and removed, exactly like `selfCreated` in AgentChat: if the
  // flag outlived its one use, switching to another thread and back would skip
  // the fetch on the return trip too, and the rail would show an empty
  // transcript for a conversation that has one.
  const adopted = useRef(new Set<string>())

  // Mirrors AgentChat's own streaming state. Closing the rail unmounts the chat
  // and aborts its turn, so anything that closes it *implicitly* (Esc, expand)
  // is held off while this is true. The explicit X button is not.
  const [streaming, setStreaming] = useState(false)
  const expandHintId = useId()

  // Derived rather than stored, so it is never possible for the transcript on
  // screen to belong to a different thread than the selected one.
  const messages =
    conversationId && loaded?.conversationId === conversationId ? loaded.messages : NO_MESSAGES

  const measurement = useMeasurement(railRef, open, panel ? `${panel.type}:${panel.id}` : null)
  // Optimistically docked until measured — the same first render on the server
  // and on the client, so hydration agrees. The CSS `max()` floor in
  // `.agent-rail-surface` bounds how wrong that can be for the one frame before
  // the layout effect runs.
  const docked = measurement === null || measurement.available >= PANEL_WIDTH_MIN

  const loadThreads = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/agent/conversations?workspaceId=${encodeURIComponent(workspaceId)}`,
      )
      if (!response.ok) return
      const data = (await response.json()) as { conversations?: RailThread[] }
      setThreads(data.conversations ?? [])
    } catch {
      // A failed list is a missing thread switcher, not a broken chat. The
      // composer and the active transcript do not depend on it.
    }
  }, [workspaceId])

  useEffect(() => {
    if (open) void loadThreads()
  }, [open, loadThreads])

  // Transcript for the selected thread. Reruns on selection, not on every
  // render, and never for a thread whose messages are already on screen.
  useEffect(() => {
    // A new chat has no transcript to fetch, and `messages` already derives to
    // the empty reference for it.
    if (!open || !conversationId) return
    if (adopted.current.has(conversationId)) {
      // Removed as it is used: this skip is good for the one render that
      // follows the turn it came from, not for every future visit. Nothing is
      // stored for it — `loaded` still holds whatever thread was open before,
      // and the id comparison above already derives this one to empty, which is
      // the correct seed for a chat whose real transcript is live in the DOM.
      adopted.current.delete(conversationId)
      return
    }

    let cancelled = false
    const id = conversationId
    void (async () => {
      // 404 covers both "deleted" and "not yours" by design (see the route),
      // and a network failure is indistinguishable from here. In every failure
      // the honest thing to show is an empty thread rather than whatever was on
      // screen before.
      let parsed = NO_MESSAGES
      try {
        const response = await fetch(
          `/api/agent/conversations/${id}/messages?workspaceId=${encodeURIComponent(workspaceId)}`,
        )
        if (response.ok) {
          const data = (await response.json()) as { messages?: unknown }
          const next = toRailMessages(data.messages)
          // Keep the shared empty reference when there is nothing to show, so an
          // empty thread does not re-trigger AgentChat's re-seed on every fetch.
          if (next.length > 0) parsed = next
        }
      } catch {
        // Handled by the empty default above.
      }
      if (!cancelled) setLoaded({ conversationId: id, messages: parsed })
    })()
    return () => {
      cancelled = true
    }
  }, [open, conversationId, workspaceId])

  const handleConversationCreated = useCallback(
    (id: string) => {
      // Recorded *before* the id is adopted: the effect above runs on the render
      // this triggers, and must already know not to refetch.
      adopted.current.add(id)
      selectConversation(id)
      // The new thread's server-generated title is only knowable by asking.
      void loadThreads()
    },
    [loadThreads, selectConversation],
  )

  const startNewChat = useCallback(() => {
    selectConversation(null)
  }, [selectConversation])

  const expandToPage = useCallback(() => {
    // The button is disabled mid-turn; this is the belt to that brace. Closing
    // would abort the turn, and for a new chat the id does not exist until the
    // turn completes, so the page would open empty.
    if (streaming) return
    // Closing is not optional: leaving the rail mounted would put two live
    // AgentChat instances on the agent page, each with its own stream. (The
    // provider also hides the rail on that route, which covers every other way
    // of getting there.)
    closeRail()
    router.push(conversationId ? `${basePath}/agent?c=${conversationId}` : `${basePath}/agent`)
  }, [basePath, closeRail, conversationId, router, streaming])

  const resolveMaxWidth = useCallback(
    // Falling back to the absolute maximum rather than the current width: a
    // gesture that silently refuses to grow reads as a broken handle, and the
    // CSS clamp still protects main content.
    () => measurement?.available ?? PANEL_WIDTH_MAX,
    [measurement],
  )

  // The rail is not a dialog in either mode, so Esc is handled here. Scoped to
  // events that bubbled out of the rail via React's synthetic tree, so Esc in a
  // main-content field cannot close it. No stopPropagation, so a Select or
  // Popover inside the rail still gets first refusal on the key.
  //
  // Closing unmounts the chat, so Esc only closes when that costs nothing:
  //  - not if something inside already used the key (`defaultPrevented`);
  //  - not from portaled content (the conversation switcher menu, tooltips):
  //    React bubbles a portal's events through this handler even though the
  //    element is outside the aside, and Esc there means "dismiss that popup";
  //  - not while a turn is streaming, which closing would abort;
  //  - not from a text field holding an unsent draft, which closing would lose.
  // The X button still closes unconditionally — that is an explicit request.
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return
    const target = event.target
    if (!(target instanceof Node) || !event.currentTarget.contains(target)) return
    if (streaming) return
    if (
      (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) &&
      target.value.trim() !== ""
    ) {
      return
    }
    closeRail()
  }

  // Built as a flat string map rather than inline in the JSX: an object literal
  // mixing a computed custom-property key with a conditional spread of known CSS
  // properties is not assertable to CSSProperties, and the alternative — two
  // near-identical <aside> branches — would unmount AgentChat on every mode flip.
  const surfaceStyle: Record<string, string> = {
    [PANEL_WIDTH_PROPERTY]: `${width}px`,
  }
  if (docked) {
    surfaceStyle["--agent-rail-max"] = `${measurement?.available ?? PANEL_WIDTH_MAX}px`
  } else {
    surfaceStyle.left = `${measurement?.navOffset ?? 0}px`
    // No main-content floor to respect while floating, so the only bound is the
    // viewport. Keeps the width the user chose while docked rather than snapping
    // to some drawer default.
    surfaceStyle.width = `min(calc(100% - 2rem), var(${PANEL_WIDTH_PROPERTY}, 448px))`
  }

  // Closing unmounts, which aborts an in-flight turn. That is the one place
  // that is acceptable: it is what the user just asked for, explicitly. Every
  // *implicit* unmount — navigating, resizing past the dock threshold, opening a
  // detail panel — is avoided by design.
  if (!open) return null

  return (
    <aside
      ref={railRef}
      data-slot="agent-rail"
      data-mode={docked ? "docked" : "overlay"}
      aria-label="Agent"
      onKeyDown={handleKeyDown}
      className={cn(
        "flex min-h-0 flex-col overflow-hidden bg-surface-panel print:hidden",
        docked
          ? // `shrink-0` keeps the flex row from squeezing the rail instead of
            // main content; the measured width bound is what keeps it honest.
            "agent-rail-surface relative shrink-0 border-r border-border-default"
          : // z-30 is the in-flow app-chrome band (see the ladder in
            // app/globals.css) — above main content, below the detail panel's
            // Sheet at 60, which must stay clickable over the top of this.
            // `bottom-16` clears the mobile bottom nav, which is fixed.
            "absolute top-0 bottom-16 z-30 rounded-r-xl border border-border-default shadow-xl md:bottom-0",
      )}
      // React diffs this against the previous props, not against the DOM, so a
      // re-render mid-drag (when --panel-w has raced ahead imperatively) writes
      // nothing and the gesture survives. Same contract as PanelShell.
      style={surfaceStyle as CSSProperties}
    >
      {/* Resizing is a negotiation with main content, and in overlay mode there
          is nothing to negotiate — the rail is floating over it. */}
      {docked && (
        <PanelResizeHandle
          side="left"
          width={width}
          surfaceRef={railRef}
          resolveMaxWidth={resolveMaxWidth}
          onCommit={commitWidth}
        />
      )}

      <div className="flex shrink-0 items-center gap-1 border-b border-border-default px-3 py-2">
        <Sparkles className="size-4 shrink-0 text-text-subtle" aria-hidden="true" />
        <h2 className="mr-auto truncate text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Agent
        </h2>

        <Button
          variant="ghost"
          size="icon-sm"
          onClick={startNewChat}
          aria-label="New chat"
          title="New chat"
        >
          <Plus aria-hidden="true" />
        </Button>

        {/* The conversation list lives here rather than inside AgentChat: the
            page shows it as a 256px column, which a 320px rail has no room for
            beside a readable thread. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Switch conversation"
                title="Switch conversation"
              />
            }
          >
            <MessagesSquare aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto">
            {threads.length === 0 && (
              <DropdownMenuItem disabled>No conversations yet</DropdownMenuItem>
            )}
            {threads.map((thread) => (
              <DropdownMenuItem
                key={thread.id}
                onClick={() => selectConversation(thread.id)}
                className={cn(thread.id === conversationId && "font-semibold")}
              >
                <span className="truncate">{thread.title || "Untitled chat"}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="ghost"
          size="icon-sm"
          onClick={expandToPage}
          disabled={streaming}
          aria-label="Open in full page"
          // Disabled buttons get no pointer events, so this native title is the
          // explanation sighted users get; aria-describedby carries it to AT.
          title={streaming ? "Available when the response finishes" : "Open in full page"}
          aria-describedby={streaming ? expandHintId : undefined}
        >
          <Maximize2 aria-hidden="true" />
        </Button>
        {streaming && (
          <span id={expandHintId} className="sr-only">
            Open in full page is available when the response finishes.
          </span>
        )}

        <Button
          variant="ghost"
          size="icon-sm"
          onClick={closeRail}
          aria-label="Close agent"
          title="Close agent"
        >
          <X aria-hidden="true" />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <AgentChat
          variant="rail"
          workspaceId={workspaceId}
          basePath={basePath}
          conversations={threads}
          activeConversationId={conversationId}
          initialMessages={messages}
          userInitials={userInitials}
          onConversationCreated={handleConversationCreated}
          onStreamingChange={setStreaming}
        />
      </div>
    </aside>
  )
}
