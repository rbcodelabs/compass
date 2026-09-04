// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { DecisionDetailsGrid, DecisionLongForm, DecisionSummary } from "@/components/decisions/decision-long-form";

describe("Decision long-form content", () => {
  it("omits the duplicate tracked summary but keeps legacy summaries", () => {
    const { rerender } = render(<DecisionSummary tracked summary="Duplicate context" />);
    expect(screen.queryByText("Duplicate context")).toBeNull();
    rerender(<DecisionSummary tracked={false} summary="Legacy summary" />);
    expect(screen.getByText("Legacy summary")).toBeInTheDocument();
  });

  it("renders context and rationale as Markdown", () => {
    render(<DecisionLongForm content={"First paragraph.\n\n- **Important**"} />);
    expect(screen.getByText("First paragraph.").tagName).toBe("P");
    expect(screen.getByText("Important").tagName).toBe("STRONG");
  });

  it("stacks decision metadata on mobile and restores label/value columns at sm", () => {
    render(<DecisionDetailsGrid><dt>Context</dt><dd>Long context</dd></DecisionDetailsGrid>);
    const list = screen.getByTestId("decision-details-grid");
    expect(list).toHaveClass("grid-cols-1", "sm:grid-cols-[10rem_1fr]");
    expect(list.className).toContain("[&_dd]:min-w-0");
  });
});
