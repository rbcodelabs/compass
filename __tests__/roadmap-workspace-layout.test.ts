// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type FunctionComponent } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

/**
 * eslint's `react/no-children-prop` requires children to be passed as a
 * `createElement` argument, but TS's `createElement` overloads require
 * `children` *inside* the props object when the component declares it
 * required. Narrowing a provider to its non-children props satisfies both.
 */
type ProviderShell = FunctionComponent<{ orgSlug: string; workspaceSlug: string }>;

afterEach(cleanup);

beforeAll(() => {
  // jsdom has no ResizeObserver; NativeTimeline observes its scroll container
  // to size the virtualization window. A no-op stub is enough to mount it.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/rbcodelabs/compass/roadmap",
  useSearchParams: () => new URLSearchParams(),
}));

// use-timeline-controller and RoadmapBoard both pull in this server-actions
// module, which transitively imports next-auth — mock it at the boundary so
// the component under test renders without a real auth/db stack.
vi.mock("@/app/[orgSlug]/[workspaceSlug]/roadmap/actions", () => ({
  moveItem: vi.fn(),
  updateSortOrder: vi.fn(),
  promoteToRoadmap: vi.fn(),
  promoteFeedbackToRoadmap: vi.fn(),
  rescheduleRoadmapItem: vi.fn(),
  addRoadmapItem: vi.fn(),
}));

vi.mock("@/components/roadmap/unscheduled-items-panel", async () => {
  const actual = await vi.importActual<typeof import("@/components/roadmap/unscheduled-items-panel")>(
    "@/components/roadmap/unscheduled-items-panel",
  );
  return {
    ...actual,
    UnscheduledItemsPanel: () => null,
    UnscheduledItemsColumn: () => null,
  };
});

describe("Roadmap dashboard workspace layout", () => {
  it("renders a roadmap-scoped responsive header with the squad grid and no dead toolbar", async () => {
    const { RoadmapHeader } = await import("@/components/roadmap/roadmap-header");
    render(createElement(RoadmapHeader, { squads: [] }));

    const header = screen.getByRole("banner");
    expect(header).toHaveAttribute("data-slot", "workspace-header");
    expect(header.className).toContain("grid-cols-[minmax(0,1fr)_auto]");
    expect(header.className).toContain("md:grid-cols-[minmax(0,1fr)_auto_auto]");

    const controls = screen.getByLabelText("Roadmap controls");
    expect(controls.className).toContain("row-start-2");
    expect(controls.className).toContain("md:row-start-1");
    // Higher timeout below: slower than the default 5s on a cold run,
    // because the first import of this component subtree pulls in the
    // full icon/dropdown/tooltip dependency graph.
  }, 20000);

  it("mounts the Roadmap header and a scrollable content region inside the native timeline, with no separate toolbar", async () => {
    // Same cold-import cost as above, plus dnd-kit and the timeline model.
    const { PanelProvider } = await import("@/components/panels/panel-context");
    const { NativeTimeline } = await import("@/components/roadmap/native-timeline/native-timeline");
    const { container } = render(
      createElement(
        PanelProvider as unknown as ProviderShell,
        { orgSlug: "rbcodelabs", workspaceSlug: "compass" },
        createElement(NativeTimeline, {
          items: [],
          squads: [],
          workspaceId: "workspace-1",
          unscheduledItems: [],
        }),
      ),
    );

    // The header actually rendered inside the timeline's own output, not just
    // a string match on the timeline's source file.
    expect(screen.getByRole("banner")).toHaveAttribute("data-slot", "workspace-header");

    const content = container.querySelector('[data-slot="workspace-content"]');
    expect(content).not.toBeNull();
    expect(content!.className).toContain("min-h-0 min-w-0 flex-1 overflow-y-auto");

    // The old standalone <TimelineToolbar> is gone: no toolbar landmark other
    // than the header's own controls exists in the rendered tree.
    expect(screen.queryAllByRole("toolbar")).toHaveLength(0);
  }, 20000);

  it("lets the Roadmap board consume the remaining desktop height with an inset scroll track", async () => {
    vi.doMock("@/components/roadmap/roadmap-card", () => ({ RoadmapCard: () => null }));
    vi.doMock("@/components/roadmap/add-item-form", () => ({ AddItemForm: () => null }));

    const { PanelProvider } = await import("@/components/panels/panel-context");
    const { RoadmapBoard } = await import("@/components/roadmap/roadmap-board");

    const { container } = render(
      createElement(
        PanelProvider as unknown as ProviderShell,
        { orgSlug: "rbcodelabs", workspaceSlug: "compass" },
        createElement(RoadmapBoard, {
          initialItems: [],
          workspaceId: "workspace-1",
          orgSlug: "rbcodelabs",
          workspaceSlug: "compass",
          launchWorkflowEnabled: true,
        }),
      ),
    );

    const boardRegion = screen.getByRole("region", { name: "Roadmap board" });
    const boardWrapper = boardRegion.parentElement!;
    expect(boardWrapper.className).toContain("flex min-h-0 flex-1 flex-col");
    expect(boardWrapper.className).toContain("md:overflow-hidden");
    expect(boardRegion.className).toContain("scroll-px-3");
    expect(boardRegion.className).toContain("sm:scroll-px-4");

    const track = container.querySelector('[data-slot="roadmap-board-track"]');
    expect(track).not.toBeNull();
    expect(track!.className.startsWith("flex h-full w-max min-w-full")).toBe(true);
    expect(track!.className).toContain("px-3 pt-3 pb-3 sm:px-4 sm:pt-4 md:px-4 md:pt-3");

    vi.doUnmock("@/components/roadmap/roadmap-card");
    vi.doUnmock("@/components/roadmap/add-item-form");
  }, 20000);

  it("gives each Roadmap column independent scrolling that fills desktop height", async () => {
    vi.doMock("@/components/roadmap/add-item-form", () => ({ AddItemForm: () => null }));

    const { RoadmapColumn } = await import("@/components/roadmap/roadmap-column");

    const { container } = render(
      createElement(RoadmapColumn, {
        horizon: "NOW",
        items: [],
        workspaceId: "workspace-1",
        orgSlug: "rbcodelabs",
        workspaceSlug: "compass",
        revalidatePathStr: "/rbcodelabs/compass/roadmap",
        onItemAdded: vi.fn(),
        onArchive: vi.fn(),
        onUpdate: vi.fn(),
      }),
    );

    const column = container.querySelector("section")!;
    expect(column).toHaveClass("min-w-[280px]", "flex-1", "md:overflow-hidden", "md:h-full");
    expect(column).not.toHaveClass("overflow-hidden");

    const body = container.querySelector("#roadmap-column-NOW")!;
    expect(body.className).toContain("md:max-h-none");
    expect(body.className).toContain("md:overflow-y-auto");

    vi.doUnmock("@/components/roadmap/add-item-form");
  }, 20000);

  // TODO(test-debt): still a source-text check, not a real render — page.tsx Server Components (auth/prisma/notFound) have no test-execution precedent in this repo yet. See Compass test-suite audit 2026-09-12 and the readFileSync anti-pattern finding. Do not treat this as verified behavior.
  describe("roadmap page wiring (source-text check only, not a real render)", () => {
    it("uses a roadmap-scoped responsive header and distinct content regions", () => {
      const page = source("app/[orgSlug]/[workspaceSlug]/roadmap/page.tsx");

      // Mounted with `squads`; extra props (e.g. custom-field filter facets) are allowed.
      expect(page).toMatch(/<RoadmapHeader\b[^>]*\bsquads=\{squads\}/);
      expect(page).not.toContain("<WorkspacePage");
      expect(page).not.toContain("toolbar={");
      expect(page).not.toContain("Drag items between horizons");
      expect(page).not.toContain("See when items are planned");
      expect(page).not.toContain("md:p-8");
      expect(page).toContain('data-slot="workspace-content"');
    });

    it("lets the Roadmap board and columns consume the remaining desktop height without clipping mobile", () => {
      const page = source("app/[orgSlug]/[workspaceSlug]/roadmap/page.tsx");

      expect(page).toContain("flex min-h-full min-w-0 flex-1 flex-col md:h-full md:min-h-0");
      expect(page).toContain('data-slot="workspace-content" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto md:overflow-hidden"');
      expect(page).not.toContain('className="flex min-h-0 flex-1 flex-col overflow-x-auto"');
    });
  });
});
