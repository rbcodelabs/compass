// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/app/[orgSlug]/[workspaceSlug]/roadmap/actions", () => ({
  moveItem: vi.fn(),
  updateSortOrder: vi.fn(),
  promoteToRoadmap: vi.fn(),
  promoteFeedbackToRoadmap: vi.fn(),
  rescheduleRoadmapItem: vi.fn(),
  addRoadmapItem: vi.fn(),
  editRoadmapItem: vi.fn(),
  archiveRoadmapItem: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/rbcodelabs/compass/roadmap",
  useSearchParams: () => new URLSearchParams(),
}));
// The board's "ready to promote" column isn't under test and pulls in its own
// action/dialog graph — same boundary the roadmap layout suite already mocks.
vi.mock("@/components/roadmap/unscheduled-items-panel", async (load) => ({
  ...(await load<typeof import("@/components/roadmap/unscheduled-items-panel")>()),
  UnscheduledItemsColumn: () => null,
}));
vi.mock("@/components/roadmap/add-item-form", () => ({ AddItemForm: () => null }));

import { PanelProvider } from "@/components/panels/panel-context";
import { RoadmapBoard } from "@/components/roadmap/roadmap-board";
import { roadmapBoardFilterKey } from "@/lib/roadmap-filters";
import type { RoadmapCardData } from "@/components/roadmap/roadmap-card";

function item(
  overrides: Partial<RoadmapCardData> & Pick<RoadmapCardData, "id" | "title">
): RoadmapCardData {
  return {
    description: null,
    horizon: "NOW",
    sortOrder: 0,
    isPrivate: false,
    solutionId: null,
    keyResultId: null,
    opportunityId: null,
    experimentId: null,
    feedbackId: null,
    startDate: null,
    endDate: null,
    updatedAt: "2026-09-16T00:00:00.000Z",
    solution: null,
    keyResult: null,
    opportunity: null,
    experiment: null,
    feedback: null,
    squad: null,
    launchChecklist: null,
    deliveryStatus: "NOT_STARTED",
    ...overrides,
  };
}

const payments = item({ id: "ri-payments", title: "Payments revamp" });
const billing = item({ id: "ri-billing", title: "Billing exports", sortOrder: 1 });

type Filters = Omit<Parameters<typeof roadmapBoardFilterKey>[0], "workspaceId"> & {
  workspaceId?: string;
};

/**
 * Mirrors how `roadmap/page.tsx` mounts the board: the filter values become its
 * React `key`. Rendering through this rather than `RoadmapBoard` bare is the
 * point of the test — the board seeds its columns from `useState` and never
 * re-syncs, so the narrowing behaviour lives entirely in the key.
 */
function Page({ items, filters = {} }: { items: RoadmapCardData[]; filters?: Filters }) {
  return (
    <PanelProvider orgSlug="rbcodelabs" workspaceSlug="compass">
      <RoadmapBoard
        key={roadmapBoardFilterKey({ workspaceId: "ws-1", ...filters })}
        initialItems={items}
        workspaceId="ws-1"
        orgSlug="rbcodelabs"
        workspaceSlug="compass"
        launchWorkflowEnabled={true}
      />
    </PanelProvider>
  );
}

afterEach(() => cleanup());

describe("roadmapBoardFilterKey", () => {
  it("is stable for the same filters and distinct for different ones", () => {
    expect(roadmapBoardFilterKey({ workspaceId: "ws-1", squad: "alpha" })).toBe(
      roadmapBoardFilterKey({ workspaceId: "ws-1", squad: "alpha" })
    );
    expect(roadmapBoardFilterKey({ workspaceId: "ws-1", squad: "alpha" })).not.toBe(
      roadmapBoardFilterKey({ workspaceId: "ws-1", squad: "beta" })
    );
    expect(roadmapBoardFilterKey({ workspaceId: "ws-1" })).not.toBe(
      roadmapBoardFilterKey({ workspaceId: "ws-2" })
    );
  });

  it("treats an absent filter and an explicitly empty one as the same view", () => {
    expect(roadmapBoardFilterKey({ workspaceId: "ws-1" })).toBe(
      roadmapBoardFilterKey({ workspaceId: "ws-1", squad: null, field: null, fieldValue: null })
    );
  });

  it("distinguishes each facet independently, so a key cannot collide across facets", () => {
    const keys = new Set([
      roadmapBoardFilterKey({ workspaceId: "ws-1", squad: "x" }),
      roadmapBoardFilterKey({ workspaceId: "ws-1", field: "x" }),
      roadmapBoardFilterKey({ workspaceId: "ws-1", fieldValue: "x" }),
    ]);
    expect(keys.size).toBe(3);
  });

  it("changes when the custom-field tag filter changes, so the board resyncs", () => {
    expect(roadmapBoardFilterKey({ workspaceId: "ws-1", field: "f1", fieldValue: "zz_alpha" })).not.toBe(
      roadmapBoardFilterKey({ workspaceId: "ws-1", field: "f1", fieldValue: "zz_beta" })
    );
    expect(roadmapBoardFilterKey({ workspaceId: "ws-1", field: "f1", fieldValue: "zz_alpha" })).toBe(
      roadmapBoardFilterKey({ workspaceId: "ws-1", field: "f1", fieldValue: "zz_alpha" })
    );
  });
});

describe("RoadmapBoard filter remount", () => {
  it("narrows the board when a custom-field tag filter change remounts it", () => {
    const { rerender } = render(<Page items={[payments, billing]} />);
    expect(screen.getByText("Payments revamp")).toBeVisible();
    expect(screen.getByText("Billing exports")).toBeVisible();

    // What the server does on `?field=f1&fieldValue=zz_alpha`: a narrowed item
    // set, and a new key because the filter changed.
    rerender(<Page items={[payments]} filters={{ field: "f1", fieldValue: "zz_alpha" }} />);

    expect(screen.getByText("Payments revamp")).toBeVisible();
    expect(screen.queryByText("Billing exports")).not.toBeInTheDocument();
  });

  it("widens the board again when the tag filter is cleared", () => {
    const { rerender } = render(
      <Page items={[payments]} filters={{ field: "f1", fieldValue: "zz_alpha" }} />
    );
    expect(screen.queryByText("Billing exports")).not.toBeInTheDocument();

    rerender(<Page items={[payments, billing]} />);

    expect(screen.getByText("Billing exports")).toBeVisible();
  });

  it("empties the board when a tag filter matches nothing", () => {
    const { rerender } = render(<Page items={[payments, billing]} />);

    rerender(<Page items={[]} filters={{ field: "f1", fieldValue: "zz_unused" }} />);

    expect(screen.queryByText("Payments revamp")).not.toBeInTheDocument();
    expect(screen.queryByText("Billing exports")).not.toBeInTheDocument();
  });

  it("narrows on a squad filter change too, not just the tag facet", () => {
    const { rerender } = render(<Page items={[payments, billing]} />);

    rerender(<Page items={[billing]} filters={{ squad: "alpha" }} />);

    expect(screen.queryByText("Payments revamp")).not.toBeInTheDocument();
    expect(screen.getByText("Billing exports")).toBeVisible();
  });

  it("leaves its client state alone when revalidation lands under an unchanged filter", () => {
    // The deliberate tradeoff of keying on the filter inputs rather than on the
    // resulting item set: an unrelated create arriving via revalidation must not
    // rebuild the columns, because that is also what would discard a pending
    // optimistic drag. This asserts the board really is seeded once per key —
    // which is exactly why the missing key made filtering a no-op.
    const { rerender } = render(<Page items={[payments]} />);

    rerender(<Page items={[payments, billing]} />);

    expect(screen.getByText("Payments revamp")).toBeVisible();
    expect(screen.queryByText("Billing exports")).not.toBeInTheDocument();
  });
});
