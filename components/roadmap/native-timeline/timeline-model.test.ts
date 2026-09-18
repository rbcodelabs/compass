import { describe, expect, it } from "vitest";
import {
  buildCustomFieldGrouping,
  buildSquadGrouping,
  buildTimelineRows,
  isBacklogCompatibleWithRow,
  isInternalTimelineDestination,
  NONE_GROUPING,
  NO_FIELD_VALUE_GROUP_ID,
  NO_SQUAD_GROUP_ID,
  PHASE_GROUPING,
} from "./timeline-model";

const squads = [
  { id: "squad-b", name: "Bravo", color: "#111111" },
  { id: "squad-a", name: "Alpha", color: "#222222" },
];

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

// Strips the row shape down to the fields that existed before grouping was
// generalized. This is the "byte-identical default output" guarantee the
// riskiest-assumption mitigation calls for: a brand-new `primaryId` field is
// allowed to appear (it has no prior meaning to preserve), but every field
// that existed before must keep exactly its old value, in exactly the same
// row order, for the exact same input.
function legacyShape(rows: ReturnType<typeof buildTimelineRows>) {
  return rows.map(({ id, kind, label, horizon, squadId, color }) => ({ id, kind, label, horizon, squadId, color }));
}

describe("buildTimelineRows default (Phase) grouping — byte-identical to pre-refactor output", () => {
  it("matches the captured baseline for a populated squad list", () => {
    expect(legacyShape(buildTimelineRows(squads))).toEqual([
      { id: "horizon:NOW", kind: "horizon", label: "Now", horizon: "NOW", squadId: null, color: "#10b981" },
      { id: "lane:NOW:squad-a", kind: "lane", label: "Alpha", horizon: "NOW", squadId: "squad-a", color: "#222222" },
      { id: "lane:NOW:squad-b", kind: "lane", label: "Bravo", horizon: "NOW", squadId: "squad-b", color: "#111111" },
      { id: "lane:NOW:unassigned", kind: "lane", label: "No squad", horizon: "NOW", squadId: null, color: null },
      { id: "horizon:NEXT", kind: "horizon", label: "Next", horizon: "NEXT", squadId: null, color: "#3b82f6" },
      { id: "lane:NEXT:squad-a", kind: "lane", label: "Alpha", horizon: "NEXT", squadId: "squad-a", color: "#222222" },
      { id: "lane:NEXT:squad-b", kind: "lane", label: "Bravo", horizon: "NEXT", squadId: "squad-b", color: "#111111" },
      { id: "lane:NEXT:unassigned", kind: "lane", label: "No squad", horizon: "NEXT", squadId: null, color: null },
      { id: "horizon:LATER", kind: "horizon", label: "Later", horizon: "LATER", squadId: null, color: "#94a3b8" },
      { id: "lane:LATER:squad-a", kind: "lane", label: "Alpha", horizon: "LATER", squadId: "squad-a", color: "#222222" },
      { id: "lane:LATER:squad-b", kind: "lane", label: "Bravo", horizon: "LATER", squadId: "squad-b", color: "#111111" },
      { id: "lane:LATER:unassigned", kind: "lane", label: "No squad", horizon: "LATER", squadId: null, color: null },
      { id: "horizon:LAUNCHING", kind: "horizon", label: "Launching", horizon: "LAUNCHING", squadId: null, color: "#f59e0b" },
      { id: "lane:LAUNCHING:squad-a", kind: "lane", label: "Alpha", horizon: "LAUNCHING", squadId: "squad-a", color: "#222222" },
      { id: "lane:LAUNCHING:squad-b", kind: "lane", label: "Bravo", horizon: "LAUNCHING", squadId: "squad-b", color: "#111111" },
      { id: "lane:LAUNCHING:unassigned", kind: "lane", label: "No squad", horizon: "LAUNCHING", squadId: null, color: null },
      { id: "horizon:LAUNCHED", kind: "horizon", label: "Launched", horizon: "LAUNCHED", squadId: null, color: "#14b8a6" },
      { id: "lane:LAUNCHED:squad-a", kind: "lane", label: "Alpha", horizon: "LAUNCHED", squadId: "squad-a", color: "#222222" },
      { id: "lane:LAUNCHED:squad-b", kind: "lane", label: "Bravo", horizon: "LAUNCHED", squadId: "squad-b", color: "#111111" },
      { id: "lane:LAUNCHED:unassigned", kind: "lane", label: "No squad", horizon: "LAUNCHED", squadId: null, color: null },
      { id: "horizon:SHIPPED", kind: "horizon", label: "Shipped", horizon: "SHIPPED", squadId: null, color: "#a855f7" },
      { id: "lane:SHIPPED:squad-a", kind: "lane", label: "Alpha", horizon: "SHIPPED", squadId: "squad-a", color: "#222222" },
      { id: "lane:SHIPPED:squad-b", kind: "lane", label: "Bravo", horizon: "SHIPPED", squadId: "squad-b", color: "#111111" },
      { id: "lane:SHIPPED:unassigned", kind: "lane", label: "No squad", horizon: "SHIPPED", squadId: null, color: null },
    ]);
  });

  it("matches the captured baseline with no squads", () => {
    expect(legacyShape(buildTimelineRows([]))).toEqual([
      { id: "horizon:NOW", kind: "horizon", label: "Now", horizon: "NOW", squadId: null, color: "#10b981" },
      { id: "lane:NOW:unassigned", kind: "lane", label: "No squad", horizon: "NOW", squadId: null, color: null },
      { id: "horizon:NEXT", kind: "horizon", label: "Next", horizon: "NEXT", squadId: null, color: "#3b82f6" },
      { id: "lane:NEXT:unassigned", kind: "lane", label: "No squad", horizon: "NEXT", squadId: null, color: null },
      { id: "horizon:LATER", kind: "horizon", label: "Later", horizon: "LATER", squadId: null, color: "#94a3b8" },
      { id: "lane:LATER:unassigned", kind: "lane", label: "No squad", horizon: "LATER", squadId: null, color: null },
      { id: "horizon:LAUNCHING", kind: "horizon", label: "Launching", horizon: "LAUNCHING", squadId: null, color: "#f59e0b" },
      { id: "lane:LAUNCHING:unassigned", kind: "lane", label: "No squad", horizon: "LAUNCHING", squadId: null, color: null },
      { id: "horizon:LAUNCHED", kind: "horizon", label: "Launched", horizon: "LAUNCHED", squadId: null, color: "#14b8a6" },
      { id: "lane:LAUNCHED:unassigned", kind: "lane", label: "No squad", horizon: "LAUNCHED", squadId: null, color: null },
      { id: "horizon:SHIPPED", kind: "horizon", label: "Shipped", horizon: "SHIPPED", squadId: null, color: "#a855f7" },
      { id: "lane:SHIPPED:unassigned", kind: "lane", label: "No squad", horizon: "SHIPPED", squadId: null, color: null },
    ]);
  });

  it("is identical whether the grouping argument is omitted or PHASE_GROUPING is passed explicitly", () => {
    expect(buildTimelineRows(squads)).toEqual(buildTimelineRows(squads, PHASE_GROUPING));
  });
});

describe("buildTimelineRows — Squad grouping", () => {
  const rows = buildTimelineRows(squads, buildSquadGrouping(squads));

  it("renders one header + single lane per squad, ordered by name, plus a trailing No squad group", () => {
    expect(rows.map((row) => [row.kind, row.label])).toEqual([
      ["horizon", "Alpha"], ["lane", "Alpha"],
      ["horizon", "Bravo"], ["lane", "Bravo"],
      ["horizon", "No squad"], ["lane", "No squad"],
    ]);
  });

  it("gives every row a null horizon — squad mode has no phase axis", () => {
    expect(rows.every((row) => row.horizon === null)).toBe(true);
  });

  it("sets the lane's squadId to the real squad id, and null for the No squad group", () => {
    const alphaLane = rows.find((row) => row.kind === "lane" && row.label === "Alpha")!;
    const noSquadLane = rows.find((row) => row.kind === "lane" && row.label === "No squad")!;
    expect(alphaLane.squadId).toBe("squad-a");
    expect(noSquadLane.squadId).toBeNull();
  });

  it("produces exactly one lane per header (no squad sub-lanes under squad headers)", () => {
    expect(rows.filter((row) => row.kind === "lane")).toHaveLength(3);
  });
});

describe("buildTimelineRows — None grouping", () => {
  const rows = buildTimelineRows(squads, NONE_GROUPING);

  it("renders no header rows at all", () => {
    expect(rows.some((row) => row.kind === "horizon")).toBe(false);
  });

  it("renders a flat list of squad lanes, ordered by name, plus No squad", () => {
    expect(rows.map((row) => row.label)).toEqual(["Alpha", "Bravo", "No squad"]);
    expect(rows.every((row) => row.kind === "lane")).toBe(true);
  });

  it("gives every lane a null horizon", () => {
    expect(rows.every((row) => row.horizon === null)).toBe(true);
  });

  it("shares the same primary bucket across every lane (single flat group)", () => {
    const ids = rows.map((row) => row.id);
    expect(ids).toEqual(["lane:__all__:squad-a", "lane:__all__:squad-b", "lane:__all__:unassigned"]);
  });
});

describe("buildTimelineRows — Custom field grouping", () => {
  const field = {
    id: "field-1",
    name: "Product Area",
    options: [
      { label: "Payments", value: "payments", color: "#ff0000" },
      { label: "Growth", value: "growth" },
    ],
  };
  const grouping = buildCustomFieldGrouping(field, { "item-payments": "payments", "item-growth": "growth", "item-missing": "unknown-value" });
  const rows = buildTimelineRows(squads, grouping);

  it("renders one header per resolved SELECT option plus a trailing No value group, each with squad sub-lanes", () => {
    expect(rows.map((row) => [row.kind, row.label])).toEqual([
      ["horizon", "Payments"], ["lane", "Alpha"], ["lane", "Bravo"], ["lane", "No squad"],
      ["horizon", "Growth"], ["lane", "Alpha"], ["lane", "Bravo"], ["lane", "No squad"],
      ["horizon", "No value"], ["lane", "Alpha"], ["lane", "Bravo"], ["lane", "No squad"],
    ]);
  });

  it("carries the option color onto its header row", () => {
    const paymentsHeader = rows.find((row) => row.kind === "horizon" && row.label === "Payments")!;
    const growthHeader = rows.find((row) => row.kind === "horizon" && row.label === "Growth")!;
    expect(paymentsHeader.color).toBe("#ff0000");
    expect(growthHeader.color).toBeNull();
  });

  it("maps items to their option's group id, and unknown/missing values to No value", () => {
    expect(grouping.primaryOf({ id: "item-payments", horizon: "NOW", squad: null })).toBe("opt-0");
    expect(grouping.primaryOf({ id: "item-growth", horizon: "NOW", squad: null })).toBe("opt-1");
    expect(grouping.primaryOf({ id: "item-missing", horizon: "NOW", squad: null })).toBe(NO_FIELD_VALUE_GROUP_ID);
    expect(grouping.primaryOf({ id: "item-unseen", horizon: "NOW", squad: null })).toBe(NO_FIELD_VALUE_GROUP_ID);
  });

  it("labels the axis with the field name", () => {
    expect(grouping.axisLabel).toBe("Product Area → Squad");
  });
});

describe("grouping primaryOf resolvers", () => {
  it("Phase grouping buckets by the item's own horizon", () => {
    expect(PHASE_GROUPING.primaryOf({ id: "x", horizon: "LATER", squad: null })).toBe("LATER");
  });

  it("Squad grouping buckets by the item's squad, falling back to No squad", () => {
    const grouping = buildSquadGrouping(squads);
    expect(grouping.primaryOf({ id: "x", horizon: "NOW", squad: { id: "squad-a" } })).toBe("squad-a");
    expect(grouping.primaryOf({ id: "x", horizon: "NOW", squad: null })).toBe(NO_SQUAD_GROUP_ID);
  });

  it("None grouping has no primary groups, so callers must not consult primaryOf", () => {
    expect(NONE_GROUPING.primaryGroups).toBeNull();
  });
});
