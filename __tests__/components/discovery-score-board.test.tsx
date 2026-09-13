// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Server actions reach for Prisma at import time — stub the whole module.
vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/actions", () => ({
  updateOpportunityStatus: vi.fn(),
  archiveOpportunity: vi.fn(),
  moveOpportunity: vi.fn(),
  reorderOpportunity: vi.fn(),
  createOpportunity: vi.fn(),
}));

vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel: vi.fn() }),
}));

import { OpportunityBoard } from "@/components/discovery/opportunity-board";
import { ScoreBadge } from "@/components/discovery/score-badge";
import type { OpportunityCardData } from "@/components/discovery/opportunity-card";
import type { OpportunityStatus } from "@/lib/types";

afterEach(cleanup);

function opp(
  id: string,
  title: string,
  sortOrder: number,
  score?: { normalizedScore: number; modelVersion?: number; liveModelVersion?: number }
): OpportunityCardData {
  return {
    id,
    title,
    customerSegment: null,
    status: "EXPLORING",
    sortOrder,
    _count: { solutions: 0, evidence: 0 },
    squad: null,
    score: score
      ? {
          normalizedScore: score.normalizedScore,
          modelVersion: score.modelVersion ?? 1,
          liveModelVersion: score.liveModelVersion ?? 1,
          stale: (score.modelVersion ?? 1) < (score.liveModelVersion ?? 1),
        }
      : null,
  };
}

function byStatus(items: OpportunityCardData[]): Record<OpportunityStatus, OpportunityCardData[]> {
  return {
    EXPLORING: items,
    VALIDATING: [],
    PRIORITIZED: [],
    ACTIVE: [],
    ARCHIVED: [],
  };
}

function renderBoard(
  items: OpportunityCardData[],
  opts: { hasActiveScoringModel?: boolean; sortByScore?: boolean } = {}
) {
  return render(
    <OpportunityBoard
      opportunitiesByStatus={byStatus(items)}
      orgSlug="acme"
      workspaceSlug="core"
      workspaceId="ws-1"
      hasActiveScoringModel={opts.hasActiveScoringModel ?? true}
      sortByScore={opts.sortByScore ?? false}
    />
  );
}

/** Card titles in the order they appear in the Exploring column. */
function renderedOrder(): string[] {
  return screen
    .getAllByRole("article")
    .map((el) => within(el).getByRole("heading").textContent?.trim() ?? "");
}

describe("ScoreBadge", () => {
  it("renders the normalized score rounded, not as a raw float", () => {
    render(
      <ScoreBadge
        score={{
          normalizedScore: 11.971830985915492,
          modelVersion: 1,
          liveModelVersion: 1,
          stale: false,
        }}
        scoringHref="/acme/core/discovery/o1?tab=scoring"
      />
    );

    const badge = screen.getByText(/Score 12/);
    expect(badge).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("11.97");
  });

  it("rounds half up and renders whole numbers unchanged", () => {
    const { rerender } = render(
      <ScoreBadge
        score={{ normalizedScore: 72.5, modelVersion: 1, liveModelVersion: 1, stale: false }}
        scoringHref="/x"
      />
    );
    expect(screen.getByText(/Score 73/)).toBeInTheDocument();

    rerender(
      <ScoreBadge
        score={{ normalizedScore: 100, modelVersion: 1, liveModelVersion: 1, stale: false }}
        scoringHref="/x"
      />
    );
    expect(screen.getByText(/Score 100/)).toBeInTheDocument();
  });

  it("renders a 'Not scored' link to the Scoring tab when unscored", () => {
    render(<ScoreBadge score={null} scoringHref="/acme/core/discovery/o1?tab=scoring" />);

    const link = screen.getByRole("link", { name: "Not scored" });
    expect(link).toHaveAttribute("href", "/acme/core/discovery/o1?tab=scoring");
  });

  it("marks a stale score with an indicator and an explanatory label naming both versions", () => {
    const { container } = render(
      <ScoreBadge
        score={{ normalizedScore: 40, modelVersion: 1, liveModelVersion: 4, stale: true }}
        scoringHref="/x"
      />
    );

    expect(container.querySelector('[data-slot="opportunity-score-stale"]')).toBeInTheDocument();

    const badge = container.querySelector('[data-slot="opportunity-score"]');
    expect(badge).toHaveAttribute("data-stale", "true");
    expect(badge?.getAttribute("aria-label")).toMatch(/stale/i);
    expect(badge?.getAttribute("aria-label")).toContain("v1");
    expect(badge?.getAttribute("aria-label")).toContain("v4");
  });

  it("does not mark a current score as stale", () => {
    const { container } = render(
      <ScoreBadge
        score={{ normalizedScore: 40, modelVersion: 4, liveModelVersion: 4, stale: false }}
        scoringHref="/x"
      />
    );
    expect(container.querySelector('[data-slot="opportunity-score-stale"]')).toBeNull();
    expect(
      container.querySelector('[data-slot="opportunity-score"]')?.getAttribute("data-stale")
    ).toBeNull();
  });
});

describe("OpportunityBoard score UI", () => {
  it("shows a score badge on every card when the workspace has an active model", () => {
    const { container } = renderBoard([
      opp("a", "Scored one", 0, { normalizedScore: 81.4 }),
      opp("b", "Unscored one", 1),
    ]);

    expect(screen.getByText(/Score 81/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Not scored" })).toHaveAttribute(
      "href",
      "/acme/core/discovery/b?tab=scoring"
    );
    expect(container.querySelectorAll('[data-slot="opportunity-score"]')).toHaveLength(1);
  });

  it("renders NO score UI at all when the workspace has no active scoring model", () => {
    const { container } = renderBoard(
      [opp("a", "Scored one", 0, { normalizedScore: 81.4 }), opp("b", "Unscored one", 1)],
      { hasActiveScoringModel: false }
    );

    expect(container.querySelector('[data-slot="opportunity-score"]')).toBeNull();
    expect(container.querySelector('[data-slot="opportunity-not-scored"]')).toBeNull();
    expect(screen.queryByText(/Score /)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Not scored" })).not.toBeInTheDocument();
    // The cards themselves still render — only the score affordances are gone.
    expect(renderedOrder()).toEqual(["Scored one", "Unscored one"]);
  });
});

describe("OpportunityBoard ordering", () => {
  const items = [
    opp("a", "Low", 0, { normalizedScore: 12 }),
    opp("b", "Unscored", 1),
    opp("c", "High", 2, { normalizedScore: 91 }),
  ];

  it("uses the persisted manual order by default", () => {
    renderBoard(items);
    expect(renderedOrder()).toEqual(["Low", "Unscored", "High"]);
  });

  it("ranks by score descending with unscored last when score sort is on", () => {
    renderBoard(items, { sortByScore: true });
    expect(renderedOrder()).toEqual(["High", "Low", "Unscored"]);
  });

  it("ignores score sort when there is no active model", () => {
    renderBoard(items, { sortByScore: true, hasActiveScoringModel: false });
    expect(renderedOrder()).toEqual(["Low", "Unscored", "High"]);
  });
});

describe("OpportunityBoard drag safety under score sort", () => {
  const items = [
    opp("a", "Low", 0, { normalizedScore: 12 }),
    opp("c", "High", 1, { normalizedScore: 91 }),
  ];

  it("offers drag handles in manual mode", () => {
    renderBoard(items);
    expect(screen.getAllByRole("button", { name: "Drag to reorder" })).toHaveLength(2);
  });

  // Guards the real hazard: sortOrder is the single persisted ordering, so a
  // drag under score sort could otherwise write score-ranked indices over the
  // user's manual board order.
  it("removes every drag handle while score sort is active", () => {
    renderBoard(items, { sortByScore: true });
    expect(screen.queryAllByRole("button", { name: "Drag to reorder" })).toHaveLength(0);
  });
});
