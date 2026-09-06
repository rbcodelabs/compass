import { describe, expect, it } from "vitest";
import { buildTimelineRows, isBacklogCompatibleWithRow, isInternalTimelineDestination } from "./timeline-model";

describe("native timeline destination policy", () => {
  const rows = buildTimelineRows([]);
  const row = (horizon: string) => rows.find((candidate) => candidate.id === `lane:${horizon}:unassigned`)!;

  it("allows backlog scheduling exactly to Now, Next, and Later", () => {
    const backlog = { kind: "feedback" as const };
    expect(isBacklogCompatibleWithRow(backlog, row("NOW"))).toBe(true);
    expect(isBacklogCompatibleWithRow(backlog, row("NEXT"))).toBe(true);
    expect(isBacklogCompatibleWithRow(backlog, row("LATER"))).toBe(true);
    expect(isBacklogCompatibleWithRow(backlog, row("LAUNCHING"))).toBe(false);
  });

  it("allows existing items exactly in planning and shipped horizons", () => {
    expect(isInternalTimelineDestination("NOW", "NEXT")).toBe(true);
    expect(isInternalTimelineDestination("NEXT", "NOW")).toBe(true);
    expect(isInternalTimelineDestination("NEXT", "LAUNCHING")).toBe(false);
    expect(isInternalTimelineDestination("NEXT", "LAUNCHED")).toBe(false);
    expect(isInternalTimelineDestination("NEXT", "SHIPPED")).toBe(true);
  });

  it("keeps launching and launched source items display-only", () => {
    for (const source of ["LAUNCHING", "LAUNCHED"] as const) {
      for (const destination of ["NOW", "NEXT", "LATER", "LAUNCHING", "LAUNCHED", "SHIPPED"] as const) {
        expect(isInternalTimelineDestination(source, destination)).toBe(false);
      }
    }
  });
});
