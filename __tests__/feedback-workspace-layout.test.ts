// @vitest-environment jsdom

import { createElement as h } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

afterEach(cleanup);

const push = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/core/feedback",
  useRouter: () => ({ push, refresh }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel: vi.fn() }),
}));

// Both reach for Prisma / revalidatePath at import time — stub the whole
// modules so the grid can mount in isolation.
vi.mock("@/app/[orgSlug]/[workspaceSlug]/feedback/actions", () => ({
  createFeedback: vi.fn(),
  updateFeedbackStatus: vi.fn(),
  linkFeedbackToOpportunity: vi.fn(),
  updateFeedbackType: vi.fn(),
}));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/roadmap/actions", () => ({
  promoteFeedbackToRoadmap: vi.fn(),
}));

import { FeedbackGrid } from "@/components/feedback/feedback-grid";
import { FeedbackHeaderActions } from "@/components/feedback/feedback-header-actions";
import { CreateFeedbackDialog } from "@/components/feedback/create-feedback-dialog";
import { DataGrid } from "@/components/data-grid/data-grid";
import { DEFAULT_FEEDBACK_QUERY } from "@/lib/feedback-query";

/** jsdom ships no usable localStorage; the grid's column preferences need one. */
function installLocalStorage() {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    writable: true,
    value: storage,
  });
}

/** jsdom has no matchMedia; the grid's useIsMobile depends on it. */
function setViewport(mobile: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: mobile,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

function feedbackGridProps(overrides: Partial<Parameters<typeof FeedbackGrid>[0]> = {}) {
  return {
    orgSlug: "acme",
    workspaceSlug: "core",
    workspaceId: "ws-1",
    items: [],
    opportunities: [],
    total: 0,
    query: DEFAULT_FEEDBACK_QUERY,
    hasAnyFeedback: true,
    ...overrides,
  };
}

describe("Feedback workspace layout", () => {
  beforeEach(() => {
    push.mockClear();
    refresh.mockClear();
    installLocalStorage();
    setViewport(false);
  });

  it("mounts FeedbackHeaderActions' toolbar host after paint and portals the Feedback grid's toolbar into it", async () => {
    const { container } = render(
      h(
        "div",
        null,
        h(FeedbackHeaderActions, { orgSlug: "acme", workspaceSlug: "core" }),
        h(FeedbackGrid, feedbackGridProps()),
      ),
    );

    // The New Feedback trigger is present immediately...
    expect(screen.getByRole("button", { name: "New Feedback" })).toBeInTheDocument();
    // ...but the toolbar host has not mounted yet, so the grid's toolbar has
    // nowhere to portal into.
    expect(container.querySelector("#feedback-header-toolbar")).toBeNull();

    // After the deferred (requestAnimationFrame-gated) mount, the host
    // appears and the grid's toolbar (with its real Filters control) portals
    // into it.
    await waitFor(
      () => {
        const host = container.querySelector("#feedback-header-toolbar");
        expect(host).not.toBeNull();
        expect(
          within(host as HTMLElement).getByRole("button", { name: "Filters" }),
        ).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  describe("CreateFeedbackDialog trigger variants", () => {
    it("renders an icon-only, ARIA-labeled trigger for the toolbar variant", () => {
      render(
        h(CreateFeedbackDialog, {
          orgSlug: "acme",
          workspaceSlug: "core",
          revalidatePathStr: "/acme/core/feedback",
          onCreated: vi.fn(),
        }),
      );

      const button = screen.getByRole("button", { name: "New Feedback" });
      expect(button).toHaveAttribute("aria-label", "New Feedback");
      expect(within(button).getByText("New Feedback")).toHaveClass("hidden", "sm:inline");
    });

    it("renders a visible-label call-to-action trigger for the empty-state variant", () => {
      render(
        h(CreateFeedbackDialog, {
          orgSlug: "acme",
          workspaceSlug: "core",
          revalidatePathStr: "/acme/core/feedback",
          onCreated: vi.fn(),
          variant: "empty-state",
        }),
      );

      const button = screen.getByRole("button", { name: "New Feedback" });
      expect(button).not.toHaveAttribute("aria-label");
      expect(within(button).getByText("New Feedback")).not.toHaveClass("hidden");
    });
  });

  it("labels the search popover, offers the Ideas/Bugs type facet with an All option, and clears filters back to the bare URL", async () => {
    render(
      h(
        "div",
        null,
        h(FeedbackHeaderActions, { orgSlug: "acme", workspaceSlug: "core" }),
        h(FeedbackGrid, feedbackGridProps({ query: { ...DEFAULT_FEEDBACK_QUERY, type: "IDEA" } })),
      ),
    );

    // Wait for the toolbar to be portaled in (see the mount test above).
    await waitFor(() => screen.getByRole("button", { name: "Filters" }), { timeout: 3000 });

    fireEvent.click(screen.getByRole("button", { name: "Search feedback" }));
    expect(await screen.findByPlaceholderText("Search feedback")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(await screen.findByRole("menuitemradio", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "Ideas" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "Bugs" })).toBeInTheDocument();

    // A type filter is active (from `query`), so "Clear all" is offered;
    // clicking it must reset both owned facets in one navigation.
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear all" }));
    expect(push).toHaveBeenCalledWith("/acme/core/feedback", { scroll: false });
  });

  describe("DataGrid toolbar host portal", () => {
    function baseGridProps(overrides: Record<string, unknown> = {}) {
      return {
        gridId: "test",
        columns: [{ id: "title", header: "Title", accessorKey: "title", meta: { label: "Title" } }],
        rows: [],
        getRowId: (row: { id: string }) => row.id,
        total: 0,
        page: 1,
        pageSize: 25,
        caption: "Test grid",
        ...overrides,
      };
    }

    it("does not observe the DOM for a toolbar host when no toolbarPortalId is given", () => {
      const observeSpy = vi.spyOn(MutationObserver.prototype, "observe");

      render(
        h(
          DataGrid as never,
          baseGridProps({
            toolbarActions: h("button", { type: "button" }, "Marker"),
          }),
        ),
      );

      expect(screen.getByRole("button", { name: "Marker" })).toBeInTheDocument();
      expect(observeSpy).not.toHaveBeenCalled();
      observeSpy.mockRestore();
    });

    it("mounts the toolbar into an externally supplied host once it appears, and disconnects its own observer on unmount", async () => {
      // Track the observe/disconnect state of EVERY observer rather than
      // spying on "whichever instance called `observe` last". Two other things
      // in this render issue the byte-identical
      // `observe(document.body, { childList: true, subtree: true })` call that
      // DataGrid makes: `@dnd-kit/core`'s rect measurement (the sortable
      // column headers) and Testing Library's own `waitFor`. Either can land
      // after DataGrid subscribes, so a single captured instance silently
      // binds to a foreign observer and then reports "disconnect called 0
      // times" even when DataGrid cleaned up correctly.
      const RealMutationObserver = globalThis.MutationObserver;
      const observing = new Set<MutationObserver>();
      class TrackedMutationObserver extends RealMutationObserver {
        observe(...args: Parameters<MutationObserver["observe"]>) {
          observing.add(this);
          return super.observe(...args);
        }
        disconnect() {
          observing.delete(this);
          return super.disconnect();
        }
      }
      globalThis.MutationObserver =
        TrackedMutationObserver as unknown as typeof MutationObserver;

      try {
        const { unmount } = render(
          h(
            DataGrid as never,
            baseGridProps({
              toolbarPortalId: "ext-host",
              toolbarActions: h("button", { type: "button" }, "Marker"),
            }),
          ),
        );

        // No host yet: the toolbar renders nowhere rather than inline...
        expect(screen.queryByRole("button", { name: "Marker" })).not.toBeInTheDocument();
        // ...but the grid is already watching the DOM for one to appear.
        expect(observing.size).toBeGreaterThan(0);

        const host = document.createElement("div");
        host.id = "ext-host";
        document.body.appendChild(host);

        await waitFor(() =>
          expect(within(host).getByRole("button", { name: "Marker" })).toBeInTheDocument(),
        );

        // `waitFor` disconnects its own observer as soon as it resolves, so
        // anything still observing here belongs to the mounted tree.
        expect(observing.size).toBeGreaterThan(0);

        unmount();

        // Nothing the mounted tree started may outlive it — DataGrid's
        // toolbar-host watcher included.
        expect(
          observing.size,
          "a MutationObserver started while the grid was mounted is still observing after unmount",
        ).toBe(0);

        document.body.removeChild(host);
      } finally {
        globalThis.MutationObserver = RealMutationObserver;
      }
    });
  });

  // TODO(test-debt): still a source-text check, not a real render — page.tsx Server Components (auth/prisma/notFound) have no test-execution precedent in this repo yet. See Compass test-suite audit 2026-09-12 and the readFileSync anti-pattern finding. Do not treat this as verified behavior.
  describe("Feedback page shell (unverified source-text check)", () => {
    it("keeps the approved controls in one title row without a byline or toolbar", () => {
      const page = source("app/[orgSlug]/[workspaceSlug]/feedback/page.tsx");

      expect(page).toContain("<WorkspacePage");
      expect(page).toContain("actions={(");
      expect(page).not.toContain("toolbar={(");
      expect(page).not.toContain("description={");
      expect(page).not.toContain("PageHeader");
      expect(page).not.toContain('className="flex flex-1 flex-col gap-6 p-4 sm:p-6 md:p-8"');
    });
  });
});
