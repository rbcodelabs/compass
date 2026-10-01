// @vitest-environment jsdom

/**
 * Component tests for the card sort board.
 *
 * These exist because two real bugs shipped past a clean typecheck and a clean
 * server render, and both were invisible to every check that did not actually
 * open the menu:
 *
 *   1. The Tally link was a Base UI ButtonPrimitive handed an anchor via
 *      `render` without `nativeButton={false}`, which Base UI reports through
 *      console.error rather than by failing to render.
 *   2. DropdownMenuLabel is a Base UI GroupLabel and throws unless it has a
 *      Group ancestor — but the popup only mounts when the menu opens, so the
 *      page rendered fine and died on first click.
 *
 * So this suite opens the menu by all three routes the feature promises, and
 * treats console.error as a failure. A console message nobody asserts on is a
 * bug with a witness and no jury.
 */

import { createElement } from "react"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DragEndEvent } from "@dnd-kit/core"

import { CardSortBoard, type BoardRow } from "@/components/card-sort/card-sort-board"
import { CardSortKanban } from "@/components/card-sort/card-sort-kanban"
import { CardSortRoundActions, CardSortRoundSummary } from "@/components/card-sort/card-sort-round-header"
import { PanelProvider } from "@/components/panels/panel-context"
import type { CardSortBoardProposal } from "@/lib/card-sort"

const refresh = vi.fn()

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
  usePathname: () => "/acme/strategy/card-sort/round-1",
  useSearchParams: () => new URLSearchParams(""),
  useParams: () => ({}),
}))

/**
 * The real DndContext, wrapped so a test can hold its onDragEnd.
 *
 * jsdom has no layout: every getBoundingClientRect is a zero rect, so dnd-kit's
 * collision detection cannot decide which column a pointer or keypress landed
 * over. Driving the sensors here would therefore test jsdom's missing layout
 * engine, not this feature.
 *
 * What the tests below do instead is hand the component's own onDragEnd a
 * faithful DragEndEvent and assert what it does with it. That is the half of the
 * gesture this repo owns — the plan it forms and the request it sends. Gesture
 * recognition itself (PointerSensor's 8px threshold, KeyboardSensor's keys,
 * closestCenter's choice of column) belongs to dnd-kit and is a browser-verified
 * claim, not one this file makes. The mapping from a dropped card to a proposal
 * is separately exhaustive in __tests__/card-sort-kanban.test.ts, over every
 * combination of current value, existing proposal, target column and round state.
 */
const dnd: { onDragEnd?: (event: DragEndEvent) => void } = {}

vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>()
  return {
    ...actual,
    DndContext: (props: Parameters<typeof actual.DndContext>[0]) => {
      dnd.onDragEnd = props.onDragEnd
      return createElement(actual.DndContext, props)
    },
  }
})

/** A drop of `objectId` onto the column holding `columnValue`. */
function drop(objectId: string, columnValue: string | null) {
  if (!dnd.onDragEnd) throw new Error("DndContext never rendered")
  dnd.onDragEnd({
    active: { id: objectId, data: { current: undefined }, rect: { current: { initial: null, translated: null } } },
    over: { id: "column", data: { current: { columnValue } }, rect: { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }, disabled: false },
    activatorEvent: new Event("pointerdown"),
    collisions: null,
    delta: { x: 0, y: 0 },
  } as unknown as DragEndEvent)
}

/**
 * Base UI reports a misuse like the nativeButton one through console.error and
 * then carries on rendering, so a test that only asserts on the DOM passes
 * while the component is broken in the browser. Promote it to a failure.
 */
let consoleErrors: string[] = []
beforeEach(() => {
  consoleErrors = []
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "))
  })
  fetchMock.mockClear()
  refresh.mockClear()
})

afterEach(() => {
  const errors = consoleErrors
  cleanup()
  vi.restoreAllMocks()
  if (errors.length) {
    throw new Error(`console.error during render/interaction:\n${errors.join("\n")}`)
  }
})

const fetchMock = vi.fn(async () =>
  new Response(JSON.stringify({ applied: ["opp-1"], skipped: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
)
vi.stubGlobal("fetch", fetchMock)

const OPTIONS = [
  { value: "must", label: "Must Do" },
  { value: "should", label: "Should Do" },
  { value: "could", label: "Could Do" },
]

const ROWS: BoardRow[] = [
  { objectId: "opp-1", title: "CARD Act audit", currentValue: "must", myProposedValue: null, myRationale: null },
  { objectId: "opp-2", title: "Rate table redesign", currentValue: "should", myProposedValue: null, myRationale: null },
  { objectId: "opp-3", title: "Unsorted item", currentValue: null, myProposedValue: "could", myRationale: null },
]

function renderBoard(overrides: Partial<Parameters<typeof CardSortBoard>[0]> = {}) {
  return render(
    createElement(CardSortBoard, {
      orgSlug: "acme",
      workspaceSlug: "strategy",
      round: {
        id: "round-1",
        name: "Priority sort",
        state: "OPEN",
        factorName: "Priority",
        proposalCount: null,
        myProposalCount: 1,
      },
      factor: { id: "field-1", name: "Priority", options: OPTIONS },
      rows: ROWS,
      isFacilitator: true,
      canSeeTally: true,
      ...overrides,
    })
  )
}

/** The body of the last proposal POST, so assertions can read objectIds/value. */
function lastProposalCall() {
  const call = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit] | undefined
  if (!call) throw new Error("fetch was never called")
  // A withdraw is a DELETE with everything in the query string, so there is not
  // always a body to parse.
  const body = call[1].body ? JSON.parse(String(call[1].body)) : null
  return { url: call[0], init: call[1], body }
}

describe("CardSortBoard", () => {
  it("renders the tally control as a link, not a Base UI button wearing an anchor", () => {
    // The tally link lives in the page top bar now (CardSortRoundActions), shared
    // by both views, so this regression pins it there.
    render(
      createElement(CardSortRoundActions, {
        orgSlug: "acme",
        workspaceSlug: "strategy",
        round: { id: "round-1", state: "OPEN" },
        view: "table",
        isFacilitator: true,
        canSeeTally: true,
      })
    )
    // Regression for bug 1, and for the half-fix that followed it. The afterEach
    // hook fails the test if Base UI complains at all; this additionally pins the
    // role, because <Button nativeButton={false} render={<Link/>}> renders an
    // anchor carrying role="button" — no console error, but the only control on
    // the page that navigates gets announced as a button.
    const tally = screen.getByRole("link", { name: /tally/i })
    expect(tally).toHaveAttribute("href", "/acme/strategy/card-sort/round-1/tally")
    expect(tally).not.toHaveAttribute("role", "button")
  })

  describe("reveal and close are one-way, so they ask first", () => {
    function renderActions(state: "OPEN" | "REVEALED") {
      render(
        createElement(CardSortRoundActions, {
          orgSlug: "acme",
          workspaceSlug: "strategy",
          round: { id: "round-1", state },
          view: "table",
          isFacilitator: true,
          canSeeTally: true,
        })
      )
    }
    function patchCalls() {
      return (fetchMock.mock.calls as unknown as [string, RequestInit][]).filter(([, init]) => init?.method === "PATCH")
    }

    it("does not reveal on the first click, and Cancel sends nothing", async () => {
      renderActions("OPEN")
      fireEvent.click(screen.getByRole("button", { name: "Reveal to everyone" }))
      const dialog = await screen.findByRole("alertdialog")
      expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument()
      expect(patchCalls()).toHaveLength(0)
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
      expect(patchCalls()).toHaveLength(0)
    })

    it("reveals only once the dialog is confirmed", async () => {
      renderActions("OPEN")
      fireEvent.click(screen.getByRole("button", { name: "Reveal to everyone" }))
      const dialog = await screen.findByRole("alertdialog")
      fireEvent.click(within(dialog).getByRole("button", { name: "Reveal to everyone" }))
      await waitFor(() => expect(patchCalls()).toHaveLength(1))
      expect(JSON.parse(String(patchCalls()[0][1].body))).toEqual({ state: "REVEALED" })
    })

    it("does not close on the first click, and confirming closes", async () => {
      renderActions("REVEALED")
      fireEvent.click(screen.getByRole("button", { name: "Close round" }))
      const dialog = await screen.findByRole("alertdialog")
      expect(patchCalls()).toHaveLength(0)
      fireEvent.click(within(dialog).getByRole("button", { name: "Close round" }))
      await waitFor(() => expect(patchCalls()).toHaveLength(1))
      expect(JSON.parse(String(patchCalls()[0][1].body))).toEqual({ state: "CLOSED" })
    })
  })

  it("opens the row menu from the kebab and offers every bucket except the one the row is in", async () => {
    renderBoard()
    fireEvent.click(screen.getByRole("button", { name: "Propose a move for CARD Act audit" }))

    // Regression for bug 2: before the Group wrapper, mounting this popup threw.
    expect(await screen.findByText("Propose move to…")).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: /Should Do/ })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: /Could Do/ })).toBeInTheDocument()
    // opp-1 is already "must", and proposing a no-op is not an opinion.
    expect(screen.queryByRole("menuitem", { name: /Must Do/ })).not.toBeInTheDocument()
  })

  it("records a proposal for the single row when a bucket is chosen", async () => {
    renderBoard()
    fireEvent.click(screen.getByRole("button", { name: "Propose a move for CARD Act audit" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: /Could Do/ }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const { url, init, body } = lastProposalCall()
    expect(url).toContain("/api/card-sort/rounds/round-1/proposals")
    expect(url).toContain("orgSlug=acme")
    expect(url).toContain("workspaceSlug=strategy")
    expect(init.method).toBe("POST")
    expect(body).toMatchObject({ objectIds: ["opp-1"], proposedValue: "could" })
    // The board re-reads server state rather than patching its own copy.
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it("opens the same menu from the keyboard and commits without a mouse", async () => {
    renderBoard()
    const kebab = screen.getByRole("button", { name: "Propose a move for Rate table redesign" })

    // A real native button in tab order, not a div with a click handler. This is
    // the part that makes the kebab reachable by Tab at all.
    expect(kebab.tagName).toBe("BUTTON")
    expect(kebab).not.toHaveAttribute("tabindex", "-1")
    kebab.focus()
    expect(kebab).toHaveFocus()

    // ArrowDown, not Enter. Base UI handles ArrowDown on the trigger itself, so
    // jsdom can observe it. Enter and Space reach the same code path only via the
    // browser's native button-activation-to-click conversion, which jsdom does
    // not implement — so asserting Enter here would test jsdom, not the feature.
    // Enter/Space on the trigger is therefore a browser-verified claim, not one
    // this file can make.
    fireEvent.keyDown(kebab, { key: "ArrowDown" })
    expect(await screen.findByText("Propose move to…")).toBeInTheDocument()

    // Commit with the keyboard too: menu items are focusable and Base UI handles
    // Enter on them directly, so the whole gesture works mouse-free.
    const item = screen.getByRole("menuitem", { name: /Must Do/ })
    item.focus()
    expect(item).toHaveFocus()
    fireEvent.keyDown(item, { key: "Enter" })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(lastProposalCall().body).toMatchObject({
      objectIds: ["opp-2"],
      proposedValue: "must",
    })
  })

  it("opens the menu on right-click, the gesture the feature was asked for", async () => {
    renderBoard()
    fireEvent.contextMenu(screen.getByText("CARD Act audit"))

    expect(await screen.findByText("Propose move to…")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("menuitem", { name: /Should Do/ }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(lastProposalCall().body).toMatchObject({
      objectIds: ["opp-1"],
      proposedValue: "should",
    })
  })

  it("proposes the same move for every selected row in one request", async () => {
    renderBoard()
    fireEvent.click(screen.getByRole("checkbox", { name: "Select CARD Act audit" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Rate table redesign" }))

    expect(screen.getByText("2 selected")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Propose move for all 2/ }))
    fireEvent.click(await screen.findByRole("menuitem", { name: /Could Do/ }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const { body } = lastProposalCall()
    // One request, both objects — not two requests, and not just the first row.
    expect(body.objectIds).toEqual(["opp-1", "opp-2"])
    expect(body.proposedValue).toBe("could")
  })

  it("offers withdraw only on rows the caller has already proposed for", async () => {
    renderBoard()

    fireEvent.click(screen.getByRole("button", { name: "Propose a move for CARD Act audit" }))
    await screen.findByText("Propose move to…")
    expect(screen.queryByRole("menuitem", { name: /Withdraw/ })).not.toBeInTheDocument()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })

    // opp-3 carries myProposedValue, so it can be taken back.
    fireEvent.click(screen.getByRole("button", { name: "Propose a move for Unsorted item" }))
    const withdraw = await screen.findByRole("menuitem", { name: /Withdraw my proposal/ })
    fireEvent.click(withdraw)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const { url, init } = lastProposalCall()
    expect(init.method).toBe("DELETE")
    expect(url).toContain("objectId=opp-3")
  })

  it("surfaces a partially applied bulk proposal instead of reporting full success", async () => {
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            applied: ["opp-1"],
            skipped: [{ objectId: "opp-2", reason: "already in that bucket" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    )
    renderBoard()
    fireEvent.click(screen.getByRole("checkbox", { name: "Select CARD Act audit" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Rate table redesign" }))
    fireEvent.click(screen.getByRole("button", { name: /Propose move for all 2/ }))
    fireEvent.click(await screen.findByRole("menuitem", { name: /Must Do/ }))

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent(/Recorded 1/)
    expect(alert).toHaveTextContent(/Skipped 1/)
    expect(alert).toHaveTextContent(/already in that bucket/)
  })

  it("shows no proposal affordances at all once the round is revealed", () => {
    renderBoard({ round: {
      id: "round-1",
      name: "Priority sort",
      state: "REVEALED",
      factorName: "Priority",
      proposalCount: 7,
      myProposalCount: 1,
    } })

    expect(screen.queryByRole("button", { name: /Propose a move for/ })).not.toBeInTheDocument()
  })

  it("says the round is frozen in the top-bar summary once it is revealed", () => {
    render(
      createElement(CardSortRoundSummary, {
        round: { state: "REVEALED", proposalCount: 7, myProposalCount: 1 },
        factorName: "Priority",
        rowCount: 3,
        canSeeTally: true,
        allRoundsHref: "/acme/strategy/card-sort",
      })
    )
    expect(screen.getByText("Revealed")).toBeInTheDocument()
    expect(screen.getByText(/3 items · you proposed 1 · 7 total/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "All rounds" })).toHaveAttribute("href", "/acme/strategy/card-sort")
  })

  it("works on a factor whose options are nothing like MoSCoW", async () => {
    // The generality claim, at the component level: same component, different
    // buckets, no branch anywhere on what the factor happens to be called.
    renderBoard({
      factor: {
        id: "field-q",
        name: "Quarter",
        options: [
          { value: "q1", label: "Q1" },
          { value: "q2", label: "Q2" },
        ],
      },
      rows: [
        { objectId: "opp-9", title: "Fax intake", currentValue: "q1", myProposedValue: null, myRationale: null },
      ],
      round: {
        id: "round-q",
        name: "Quarter sort",
        state: "OPEN",
        factorName: "Quarter",
        proposalCount: null,
        myProposalCount: 0,
      },
    })

    expect(screen.getByText("Current Quarter")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Propose a move for Fax intake" }))
    expect(await screen.findByRole("menuitem", { name: /Q2/ })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: /Q1/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/Must Do/)).not.toBeInTheDocument()
  })
})

// ── Kanban ──────────────────────────────────────────────────────────────────

const KANBAN_ROWS = ROWS.map(({ objectId, title, currentValue }) => ({
  objectId,
  title,
  currentValue,
}))

/** Dana's proposal: another user, so it must only ever appear once revealed. */
const DANA_PROPOSAL: CardSortBoardProposal = {
  objectId: "opp-1",
  userId: "user-dana",
  userName: "Dana",
  proposedValue: "could",
  fromValue: "must",
  rationale: "Compliance already covers this",
  isMine: false,
}

const MY_PROPOSAL: CardSortBoardProposal = {
  objectId: "opp-2",
  userId: "user-me",
  userName: "Me",
  proposedValue: "must",
  fromValue: "should",
  rationale: null,
  isMine: true,
}

function renderKanban(overrides: Partial<Parameters<typeof CardSortKanban>[0]> = {}) {
  // Real cards open the detail panel, so the kanban needs the provider the
  // workspace layout supplies in the app.
  return render(
    <PanelProvider orgSlug="acme" workspaceSlug="strategy">
      <CardSortKanban
        orgSlug="acme"
        workspaceSlug="strategy"
        round={{
          id: "round-1",
          name: "Priority sort",
          state: "OPEN",
          factorName: "Priority",
          proposalCount: null,
          myProposalCount: 0,
        }}
        factor={{ id: "field-1", name: "Priority", options: OPTIONS }}
        rows={KANBAN_ROWS}
        proposals={[]}
        isFacilitator
        canSeeTally={false}
        {...overrides}
      />
    </PanelProvider>
  )
}

// A column is named "<label>: N official[, M proposed in]" — the official count
// first, because that is the number that must never drift.
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const column = (name: string) =>
  screen.getByRole("region", { name: new RegExp(`^${escapeRegExp(name)}: \\d+ official`) })

describe("CardSortKanban", () => {
  it("lays the round's own buckets out as columns, plus one for objects with no value", () => {
    renderKanban()
    // Generic: these columns are the factor's effective options, not a hardcoded
    // status enum. opp-3 has no Priority at all and still has somewhere to live.
    expect(column("Must Do")).toBeInTheDocument()
    expect(column("Should Do")).toBeInTheDocument()
    expect(column("Could Do")).toBeInTheDocument()
    expect(within(column("(No value)")).getByText("Unsorted item")).toBeInTheDocument()
  })

  it("turns a drop into a proposal naming the column that was dropped on", async () => {
    renderKanban()
    drop("opp-1", "could")

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const { url, init, body } = lastProposalCall()
    expect(url).toContain("/api/card-sort/rounds/round-1/proposals")
    expect(init.method).toBe("POST")
    expect(body).toMatchObject({ objectIds: ["opp-1"], proposedValue: "could" })
    // fromValue is deliberately absent: the server reads the official value
    // itself rather than trusting a possibly-stale board's idea of it.
    expect(body).not.toHaveProperty("fromValue")
  })

  it("never writes the official value — a drop proposes and nothing else", async () => {
    renderKanban()
    // opp-1 is officially Must Do.
    expect(within(column("Must Do")).getByText("CARD Act audit")).toBeInTheDocument()

    drop("opp-1", "could")
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    // 1. Every request this component can make goes to the proposals endpoint.
    //    There is no call to a custom-field endpoint because the client has no
    //    function that could make one (see use-card-sort-proposals.ts).
    for (const [url, init] of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(url).toContain("/api/card-sort/rounds/round-1/proposals")
      expect(["POST", "DELETE"]).toContain(init.method)
    }

    // 2. Nothing moved optimistically. The card relocates only when the server
    //    sends back a proposal that says so (see the landing test below), and
    //    even then the official value is untouched — which is why the header
    //    below counts live values rather than rendered cards.
    //    components/discovery/opportunity-board.tsx moves its card on drop
    //    because it really did mutate the record; this one must not.
    expect(within(column("Must Do")).getByText("CARD Act audit")).toBeInTheDocument()
    expect(within(column("Could Do")).queryByText("CARD Act audit")).not.toBeInTheDocument()
  })

  it("lands my own proposed card in the target and leaves a dashed outline behind", () => {
    // The drag lands: the card I moved looks like a card, in the column I put it
    // in. What marks where it officially still sits is the hole it left.
    renderKanban({
      proposals: [MY_PROPOSAL],
      round: {
        id: "round-1",
        name: "Priority sort",
        state: "OPEN",
        factorName: "Priority",
        proposalCount: null,
        myProposalCount: 1,
      },
    })

    // opp-2 is officially Should Do; I proposed Must Do. The solid card — the one
    // with a drag handle — is in Must Do, and says where it really belongs.
    const must = column("Must Do")
    expect(
      within(must).getByRole("button", {
        name: "Drag Rate table redesign to propose a move",
      })
    ).toBeInTheDocument()
    expect(within(must).getByText(/officially still in/).parentElement).toHaveTextContent("Should Do")

    // Should Do keeps only the outline: no drag handle, so no solid card.
    // Should Do keeps the ghost of the same real card, pointing where I sent it.
    const vacated = screen.getByRole("region", { name: "Proposed away from Should Do" })
    expect(
      within(vacated).getByRole("button", { name: /Still officially here:\s*Rate table redesign/ })
    ).toBeInTheDocument()
    expect(within(vacated).getByText(/you proposed moving it to/).parentElement).toHaveTextContent(
      "Must Do"
    )
    expect(
      within(column("Should Do")).queryByRole("button", { name: /Drag Rate table redesign/ })
    ).not.toBeInTheDocument()

    // The ghost adds no tab stops. Its title still opens the detail panel by
    // mouse (tabIndex -1), and its badges are inert; withdraw lives on the solid
    // card, so a focus stop here would be a duplicate.
    const tabStops = [
      ...vacated.querySelectorAll<HTMLElement>('[tabindex], button, a[href], [role="button"]'),
    ].filter((element) => element.tabIndex >= 0 && !element.closest("[inert]"))
    expect(tabStops).toHaveLength(0)

    // And the headers do not lie. Must Do renders two cards but owns one object;
    // Should Do renders none but still owns opp-2. Only a CustomFieldValue write
    // could change either number, and nothing here writes one.
    expect(within(must).getByLabelText("1 items")).toHaveTextContent("1")
    expect(must).toHaveAccessibleName("Must Do: 1 official, 1 proposed in")
    expect(within(column("Should Do")).getByLabelText("1 items")).toBeInTheDocument()
    expect(column("Should Do")).toHaveAccessibleName("Should Do: 1 official")
  })

  it("renders another user's revealed proposal as a marker, never as a solid card", () => {
    // Somebody else's proposal cannot use the landing treatment: once a round is
    // revealed, three people can name three destinations for one object, and a
    // card cannot be solid in three columns. So it arrives as a marker, and the
    // object's own card stays exactly where it officially is.
    renderKanban({
      round: {
        id: "round-1",
        name: "Priority sort",
        state: "REVEALED",
        factorName: "Priority",
        proposalCount: 1,
        myProposalCount: 0,
      },
      proposals: [DANA_PROPOSAL],
    })

    expect(within(column("Must Do")).getByText("CARD Act audit")).toBeInTheDocument()

    const proposed = screen.getByRole("region", { name: "Others propose into Could Do" })
    expect(within(proposed).getByText("CARD Act audit")).toBeInTheDocument()
    expect(within(proposed).getByText(/from Must Do/)).toBeInTheDocument()
    expect(within(proposed).getByRole("button", { name: /^1\s*proposer\b/ })).toBeInTheDocument()

    // The marker is the ONLY mention of the object in Could Do — no second card,
    // and none of the landed card's "you moved this here" framing, which is what
    // keeps my own move distinguishable from somebody else's at a glance.
    expect(within(column("Could Do")).getAllByText("CARD Act audit")).toHaveLength(1)
    expect(within(column("Could Do")).queryByText(/You moved this here/)).not.toBeInTheDocument()
    // Nothing was vacated either: I did not move it, so Must Do has no hole.
    expect(screen.queryByRole("region", { name: "Proposed away from Must Do" })).not.toBeInTheDocument()
    expect(within(column("Must Do")).queryByText(/Still officially here/)).not.toBeInTheDocument()
  })

  it("withdraws from the landed card, and dropping it back home withdraws too", async () => {
    renderKanban({ proposals: [MY_PROPOSAL], round: {
      id: "round-1",
      name: "Priority sort",
      state: "OPEN",
      factorName: "Priority",
      proposalCount: null,
      myProposalCount: 1,
    } })

    // opp-2 is officially Should Do and I proposed Must Do, so the solid card now
    // sits in Must Do and carries the withdraw control — on the card the reader is
    // already looking at, not on the outline left behind in another column.
    const undo = within(column("Must Do")).getByRole("button", {
      name: "Withdraw proposal for Rate table redesign",
    })
    fireEvent.click(undo)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(lastProposalCall().init.method).toBe("DELETE")
    expect(lastProposalCall().url).toContain("objectId=opp-2")

    // Same outcome by gesture: dragging it back onto its own column.
    fetchMock.mockClear()
    drop("opp-2", "should")
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(lastProposalCall().init.method).toBe("DELETE")
    expect(lastProposalCall().url).toContain("objectId=opp-2")
  })

  it("offers no way to propose once the round is closed, and refuses a drop if one arrives", async () => {
    renderKanban({
      round: {
        id: "round-1",
        name: "Priority sort",
        state: "CLOSED",
        factorName: "Priority",
        proposalCount: 3,
        myProposalCount: 1,
      },
      proposals: [MY_PROPOSAL],
    })

    // "Proposals are frozen" is said once, in the top-bar summary (tested above).
    expect(screen.queryByRole("button", { name: /Propose a move for/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Withdraw/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^Drag / })).not.toBeInTheDocument()

    // Belt and braces: even if a drop reached the handler, it records nothing and
    // says why. The server rejects it independently; this is the client not
    // pretending otherwise.
    drop("opp-1", "could")
    expect(await screen.findByRole("alert")).toHaveTextContent(/CLOSED/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("renders exactly the proposals the server sent, so a blind round stays blind", async () => {
    // OPEN: the server sends only the caller's own proposals (loadCardSortBoard
    // does not even query the others), so Dana is nowhere on the board and no
    // "proposed in" zone hints that she voted.
    const { unmount } = renderKanban({ proposals: [MY_PROPOSAL] })
    expect(screen.queryByText(/Dana/)).not.toBeInTheDocument()
    expect(
      screen.queryByText(/Compliance already covers this/)
    ).not.toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "Others propose into Could Do" })).not.toBeInTheDocument()
    unmount()

    // REVEALED: the same component shows her, because the server sent her. The
    // component has no filter of its own in either direction — the gate is
    // server-side, which is what keeps it enforceable.
    renderKanban({
      round: {
        id: "round-1",
        name: "Priority sort",
        state: "REVEALED",
        factorName: "Priority",
        proposalCount: 2,
        myProposalCount: 1,
      },
      proposals: [MY_PROPOSAL, DANA_PROPOSAL],
    })
    const proposed = screen.getByRole("region", { name: "Others propose into Could Do" })
    // The marker's drill-in is collapsed until asked for, so the proposer's name
    // is genuinely absent from the DOM until it is opened — which is also the
    // reason the OPEN half above is a real assertion and not a false negative.
    fireEvent.click(within(proposed).getByRole("button", { name: /show who and why/ }))
    expect(await within(proposed).findByText(/Dana/)).toBeInTheDocument()
    expect(within(proposed).getByText(/Compliance already covers this/)).toBeInTheDocument()
  })

  it("produces the same request from the card menu as from the drag", async () => {
    renderKanban()
    fireEvent.click(screen.getByRole("button", { name: "Propose a move for CARD Act audit" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: /Could Do/ }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const viaMenu = lastProposalCall()

    fetchMock.mockClear()
    drop("opp-1", "could")
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const viaDrag = lastProposalCall()

    // Identical, not merely equivalent: both go through useCardSortProposals, so
    // there is one request shape rather than two that have to be kept in step.
    expect(viaDrag.url).toBe(viaMenu.url)
    expect(viaDrag.init.method).toBe(viaMenu.init.method)
    expect(viaDrag.body).toEqual(viaMenu.body)
  })

  it("keeps the right-click menu reachable on a card, and by keyboard too", async () => {
    renderKanban()
    fireEvent.contextMenu(screen.getByText("CARD Act audit"))
    expect(await screen.findByText("Propose move to…")).toBeInTheDocument()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })

    // The keyboard route is a real button in tab order, not dnd-kit's keyboard
    // sensor: that sensor only helps someone who already knows the card can be
    // dragged. This is what a Tab key finds unaided.
    const kebab = screen.getByRole("button", { name: "Propose a move for CARD Act audit" })
    expect(kebab.tagName).toBe("BUTTON")
    kebab.focus()
    expect(kebab).toHaveFocus()
    fireEvent.keyDown(kebab, { key: "ArrowDown" })
    const item = await screen.findByRole("menuitem", { name: /Should Do/ })
    item.focus()
    fireEvent.keyDown(item, { key: "Enter" })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(lastProposalCall().body).toMatchObject({
      objectIds: ["opp-1"],
      proposedValue: "should",
    })
  })

  it("never leaves a focusable element hidden from assistive tech", () => {
    // Regression. The drag handle takes role="button" and tabIndex={0} from
    // useDraggable's `attributes`, so it is a tab stop whether or not we want one
    // — and it used to also carry aria-hidden, which is a focus stop that screen
    // readers are told does not exist. Browser-verified: Tab really did land on
    // it, nameless, once per card.
    // Rendered with a proposal of my own, so the sweep covers a landed card and
    // the outline it left as well as an ordinary resident.
    renderKanban({
      proposals: [MY_PROPOSAL],
      round: {
        id: "round-1",
        name: "Priority sort",
        state: "OPEN",
        factorName: "Priority",
        proposalCount: null,
        myProposalCount: 1,
      },
    })
    const focusable = [
      ...document.querySelectorAll<HTMLElement>('[tabindex="0"], button, a[href]'),
    ]
    expect(focusable.length).toBeGreaterThan(0)
    for (const element of focusable) {
      expect(element.closest("[aria-hidden='true']")).toBeNull()
    }

    // And the handle is named after its card, so "draggable" is not the only
    // thing announced about it.
    const handle = screen.getByRole("button", {
      name: "Drag CARD Act audit to propose a move",
    })
    expect(handle).toHaveAttribute("aria-roledescription", "draggable")
  })
})
