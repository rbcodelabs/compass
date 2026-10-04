import { describe, expect, it } from "vitest";
import {
  DEFAULT_DURATION_DAYS,
  durationDaysFor,
  horizonForStart,
  planAutoAdd,
  planLinkedSync,
  proposeBatch,
  rangeFromStart,
  suggestSlot,
} from "@/lib/roadmap/scheduling";

const TODAY = "2026-10-05";

describe("durationDaysFor", () => {
  it("defaults to six weeks when the solution has no effort", () => {
    expect(DEFAULT_DURATION_DAYS).toBe(42);
    expect(durationDaysFor(undefined)).toBe(42);
    expect(durationDaysFor(null)).toBe(42);
    expect(durationDaysFor(0)).toBe(42);
    expect(durationDaysFor(Number.NaN)).toBe(42);
  });

  it("converts effort weeks to days and clamps absurd values", () => {
    expect(durationDaysFor(4)).toBe(28);
    expect(durationDaysFor(2.5)).toBe(18);
    expect(durationDaysFor(0.1)).toBe(7);
    expect(durationDaysFor(500)).toBe(365);
  });
});

describe("rangeFromStart", () => {
  it("builds an inclusive range of the requested length", () => {
    expect(rangeFromStart("2026-10-05", 42)).toEqual({ start: "2026-10-05", end: "2026-11-15" });
    expect(rangeFromStart("2026-10-05", 1)).toEqual({ start: "2026-10-05", end: "2026-10-05" });
  });
});

describe("horizonForStart", () => {
  it("maps the start offset from today onto Now / Next / Later", () => {
    expect(horizonForStart("2026-10-05", TODAY)).toBe("NOW");
    expect(horizonForStart("2026-09-01", TODAY)).toBe("NOW");
    expect(horizonForStart("2026-11-29", TODAY)).toBe("NOW"); // 55 days
    expect(horizonForStart("2026-11-30", TODAY)).toBe("NEXT"); // 56 days
    expect(horizonForStart("2027-01-24", TODAY)).toBe("NEXT"); // 111 days
    expect(horizonForStart("2027-01-25", TODAY)).toBe("LATER"); // 112 days
  });
});

describe("suggestSlot", () => {
  it("starts at the floor date when the squad row is empty", () => {
    expect(suggestSlot({ occupied: [], durationDays: 14, notBefore: TODAY })).toEqual({ start: TODAY, end: "2026-10-18" });
  });

  it("slides past items that block the floor date", () => {
    const slot = suggestSlot({
      occupied: [{ start: "2026-10-01", end: "2026-10-20" }],
      durationDays: 14,
      notBefore: TODAY,
    });
    expect(slot).toEqual({ start: "2026-10-21", end: "2026-11-03" });
  });

  it("uses a gap between items only when the whole duration fits", () => {
    const occupied = [
      { start: "2026-10-05", end: "2026-10-11" },
      { start: "2026-10-19", end: "2026-10-30" },
    ];
    // Gap is Oct 12-18 (7 days): a 7-day item fits, a 14-day item does not.
    expect(suggestSlot({ occupied, durationDays: 7, notBefore: TODAY })).toEqual({ start: "2026-10-12", end: "2026-10-18" });
    expect(suggestSlot({ occupied, durationDays: 14, notBefore: TODAY })).toEqual({ start: "2026-10-31", end: "2026-11-13" });
  });

  it("ignores unsorted input and items that ended before the floor", () => {
    const slot = suggestSlot({
      occupied: [
        { start: "2026-10-19", end: "2026-10-30" },
        { start: "2026-08-01", end: "2026-09-01" },
        { start: "2026-10-05", end: "2026-10-18" },
      ],
      durationDays: 10,
      notBefore: TODAY,
    });
    expect(slot).toEqual({ start: "2026-10-31", end: "2026-11-09" });
  });
});

describe("proposeBatch", () => {
  const candidate = (id: string, squadId: string | null, score: number | null, durationDays = 14) => ({
    solutionId: id,
    squadId,
    score,
    durationDays,
  });

  it("places higher scored solutions first and never overlaps within a squad", () => {
    const proposals = proposeBatch({
      candidates: [candidate("low", "s1", 50), candidate("high", "s1", 90), candidate("mid", "s1", 70)],
      existing: [],
      today: TODAY,
    });
    expect(proposals.map((p) => p.solutionId)).toEqual(["high", "mid", "low"]);
    expect(proposals[0]).toMatchObject({ start: "2026-10-05", end: "2026-10-18" });
    expect(proposals[1]).toMatchObject({ start: "2026-10-19", end: "2026-11-01" });
    expect(proposals[2]).toMatchObject({ start: "2026-11-02", end: "2026-11-15" });
  });

  it("packs each squad independently and respects existing roadmap items", () => {
    const proposals = proposeBatch({
      candidates: [candidate("a", "s1", 80), candidate("b", "s2", 60), candidate("c", null, 10)],
      existing: [{ squadId: "s1", start: "2026-10-05", end: "2026-10-18" }],
      today: TODAY,
    });
    const byId = Object.fromEntries(proposals.map((p) => [p.solutionId, p]));
    expect(byId.a.start).toBe("2026-10-19");
    expect(byId.b.start).toBe(TODAY);
    expect(byId.c.start).toBe(TODAY);
  });

  it("sorts unscored solutions last and breaks ties by id so results are stable", () => {
    const proposals = proposeBatch({
      candidates: [candidate("z", "s1", null), candidate("b", "s1", 70), candidate("a", "s1", 70)],
      existing: [],
      today: TODAY,
    });
    expect(proposals.map((p) => p.solutionId)).toEqual(["a", "b", "z"]);
  });

  it("derives the horizon from where each proposal lands", () => {
    const proposals = proposeBatch({
      candidates: [candidate("a", "s1", 90, 70), candidate("b", "s1", 80, 70)],
      existing: [],
      today: TODAY,
    });
    expect(proposals[0].horizon).toBe("NOW");
    expect(proposals[1].horizon).toBe("NEXT");
  });
});

describe("planAutoAdd", () => {
  const base = { previousStatus: "VALIDATED", status: "IN_DELIVERY", hasActiveItem: false, hasAutoTombstone: false };

  it("creates exactly when a solution first reaches Building", () => {
    expect(planAutoAdd(base)).toEqual({ create: true });
  });

  it("never triggers for Validated or any other status", () => {
    for (const status of ["IDEA", "VALIDATED", "SHIPPED", "KILLED"]) {
      expect(planAutoAdd({ ...base, status })).toEqual({ create: false, reason: "not-building" });
    }
  });

  it("does not re-trigger when the status did not change", () => {
    expect(planAutoAdd({ ...base, previousStatus: "IN_DELIVERY" })).toEqual({ create: false, reason: "no-transition" });
  });

  it("is idempotent: an active linked item blocks creation", () => {
    expect(planAutoAdd({ ...base, hasActiveItem: true })).toEqual({ create: false, reason: "already-scheduled" });
  });

  it("is suppressed once a user removed or undid the auto-created item", () => {
    expect(planAutoAdd({ ...base, hasAutoTombstone: true })).toEqual({ create: false, reason: "suppressed" });
  });
});

describe("planLinkedSync", () => {
  const item = {
    title: "Old title",
    horizon: "NEXT",
    startDate: "2026-12-01",
    endDate: "2026-12-14",
    scheduleEdited: false,
  };

  it("renames a linked item that still carries the solution's previous title", () => {
    expect(planLinkedSync({ item, today: TODAY, change: { previousTitle: "Old title", title: "New title" } })).toEqual({ title: "New title" });
  });

  it("keeps a title the user changed by hand", () => {
    expect(planLinkedSync({ item: { ...item, title: "My own name" }, today: TODAY, change: { previousTitle: "Old title", title: "New title" } })).toBeNull();
  });

  it("pulls an unedited future item to Now and today when the solution starts building", () => {
    expect(planLinkedSync({ item, today: TODAY, change: { previousStatus: "VALIDATED", status: "IN_DELIVERY" } })).toEqual({
      horizon: "NOW",
      startDate: TODAY,
      endDate: "2026-10-18",
    });
  });

  it("stops following dates and horizon once the user edited the schedule", () => {
    expect(planLinkedSync({ item: { ...item, scheduleEdited: true }, today: TODAY, change: { previousStatus: "VALIDATED", status: "IN_DELIVERY" } })).toBeNull();
  });

  it("does not move an item that is already underway", () => {
    const underway = { ...item, horizon: "NOW", startDate: "2026-09-20", endDate: "2026-10-31" };
    expect(planLinkedSync({ item: underway, today: TODAY, change: { previousStatus: "VALIDATED", status: "IN_DELIVERY" } })).toBeNull();
  });

  it("follows a shipped solution into the Shipped horizon without touching dates", () => {
    expect(planLinkedSync({ item, today: TODAY, change: { previousStatus: "IN_DELIVERY", status: "SHIPPED" } })).toEqual({ horizon: "SHIPPED" });
  });

  it("ignores statuses with no roadmap meaning", () => {
    expect(planLinkedSync({ item, today: TODAY, change: { previousStatus: "IDEA", status: "VALIDATED" } })).toBeNull();
    expect(planLinkedSync({ item, today: TODAY, change: { previousStatus: "VALIDATED", status: "KILLED" } })).toBeNull();
  });
});
