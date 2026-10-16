// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";

vi.mock("@/app/[orgSlug]/[workspaceSlug]/okrs/actions", () => ({
  deleteKeyResult: vi.fn(),
  setObjectiveParentKR: vi.fn(),
  logCheckIn: vi.fn(),
}));
vi.mock("@/components/panels/panel-context", () => ({ usePanelContext: () => ({ openPanel: vi.fn() }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/okrs/check-in-form", () => ({ CheckInForm: () => null }));
vi.mock("@/components/ui/card-menu", () => ({ CardMenu: () => null }));

import { KeyResultBar } from "@/components/okrs/key-result-bar";
import { KrHero } from "@/components/okrs/kr-progress-history";
import { CycleCard } from "@/components/okrs/cycle-card";
import type { CycleCardData } from "@/components/okrs/cycle-card";

afterEach(cleanup);

function renderBar(unit: string | null, hideProgress?: boolean) {
  return render(
    <DndContext>
      <SortableContext items={["k1"]}>
        <KeyResultBar
          keyResult={{ id: "k1", title: "Signups", current: 0, target: 500000, unit }}
          orgSlug="org"
          workspaceSlug="ws"
          hideProgress={hideProgress}
        />
      </SortableContext>
    </DndContext>,
  );
}

describe("KeyResultBar unit display", () => {
  it("shows the unit once, after the target", () => {
    const { container } = renderBar("users");
    expect(container.querySelector(".okx-kr-value")?.textContent).toBe("0 / 500000 users");
  });

  it("shows no unit text when the key result has none", () => {
    const { container } = renderBar(null);
    expect(container.querySelector(".okx-kr-value")?.textContent).toBe("0 / 500000");
  });
});

describe("KeyResultBar hideProgress", () => {
  it("renders the bar and percentage by default", () => {
    const { container } = renderBar("users");
    expect(container.querySelector(".okx-kr-bar")).not.toBeNull();
    expect(container.querySelector(".okx-kr-pct")).not.toBeNull();
  });

  it("omits the bar and percentage but keeps the values", () => {
    const { container } = renderBar("users", true);
    expect(container.querySelector(".okx-kr-bar")).toBeNull();
    expect(container.querySelector(".okx-kr-pct")).toBeNull();
    expect(container.querySelector(".okx-kr-value")?.textContent).toBe("0 / 500000 users");
    expect(container.querySelector(".okx-kr-row")).toHaveAttribute("data-no-progress", "true");
  });
});

describe("KrHero hideProgress", () => {
  it("drops the percentage and track for an unstarted period", () => {
    const { container } = render(<KrHero current={0} target={10} unit="users" elapsed={null} hideProgress />);
    expect(container.querySelector(".okx-kr-big em")).toBeNull();
    expect(container.querySelector(".okx-track")).toBeNull();
    expect(screen.getByText(/of 10 users/)).toBeInTheDocument();
  });

  it("keeps them otherwise", () => {
    const { container } = render(<KrHero current={5} target={10} unit="users" elapsed={null} />);
    expect(container.querySelector(".okx-kr-big em")?.textContent).toBe("50%");
    expect(container.querySelector(".okx-track")).not.toBeNull();
  });
});

describe("CycleCard for a not-yet-started period", () => {
  const base = (over: Partial<CycleCardData["timing"]>): CycleCardData => ({
    id: "c1",
    title: "Q1 2027",
    startDate: new Date("2027-01-01"),
    endDate: new Date("2027-03-31"),
    status: "ACTIVE",
    rollup: {
      progress: 0,
      objectiveCount: 2,
      keyResultCount: 3,
      statusMix: { ON_TRACK: 2, AT_RISK: 0, OFF_TRACK: 0, COMPLETE: 0 },
    } as CycleCardData["rollup"],
    timing: { percentElapsed: 0, daysLeft: 90, daysUntilStart: 30, phase: "upcoming", ...over },
  });

  it("shows no progress percentage or track", () => {
    const { container } = render(<CycleCard cycle={base({})} orgSlug="org" workspaceSlug="ws" />);
    expect(container.querySelector(".okx-pace-pct")).toBeNull();
    expect(container.querySelector(".okx-track")).toBeNull();
    expect(screen.getByText("Not started")).toBeInTheDocument();
  });

  it("still shows progress once the period is running", () => {
    const { container } = render(
      <CycleCard cycle={base({ phase: "running", percentElapsed: 40 })} orgSlug="org" workspaceSlug="ws" />,
    );
    expect(container.querySelector(".okx-pace-pct")).not.toBeNull();
  });
});
