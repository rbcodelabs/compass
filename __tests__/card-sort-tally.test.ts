import { describe, it, expect } from "vitest";
import {
  CONTESTED_DEFINITION,
  computeNetFlow,
  rankContested,
  tallyByObject,
  type TallyObject,
  type TallyProposal,
} from "@/lib/card-sort-tally";
import type { SelectOption } from "@/lib/types";

/**
 * The MoSCoW option set from the real Strategic Initiatives Priority field, used
 * here only as realistic data. Nothing in the module under test knows these
 * values — the Quarter case at the bottom of this file proves that.
 */
const MOSCOW: SelectOption[] = [
  { label: "Must Do (contractually obligated)", value: "must_do_(contractually_obligated)" },
  { label: "Should Do (top strategic initiative)", value: "should_do_(top_strategic_initiative)" },
  { label: "Could Do (nice to have)", value: "could_do_(nice_to_have)" },
  { label: "Shouldn't Do", value: "shouldn't_do" },
  { label: "In Flight", value: "in_flight" },
  { label: "Q3 / Done / BAU", value: "q3_/_done_/_bau" },
  { label: "Uncategorized", value: "uncategorized" },
];

const MUST = "must_do_(contractually_obligated)";
const SHOULD = "should_do_(top_strategic_initiative)";
const COULD = "could_do_(nice_to_have)";
const WONT = "shouldn't_do";

function proposal(
  objectId: string,
  userName: string,
  proposedValue: string,
  fromValue: string | null
): TallyProposal {
  return { objectId, userId: `user-${userName}`, userName, proposedValue, fromValue };
}

describe("tallyByObject", () => {
  const objects: TallyObject[] = [
    { objectId: "obj-a", title: "Rate table redesign", currentValue: MUST },
    { objectId: "obj-b", title: "Savings hub", currentValue: SHOULD },
    { objectId: "obj-c", title: "Nobody looked at this", currentValue: COULD },
  ];

  it("groups proposals per object and names every proposer", () => {
    const tallies = tallyByObject(objects, [
      proposal("obj-a", "rick", SHOULD, MUST),
      proposal("obj-a", "dana", SHOULD, MUST),
      proposal("obj-a", "sam", COULD, MUST),
    ]);
    const a = tallies.find((t) => t.objectId === "obj-a")!;

    expect(a.proposalCount).toBe(3);
    expect(a.distinctTargetCount).toBe(2);
    // Most-proposed target first.
    expect(a.targets.map((t) => [t.value, t.count])).toEqual([
      [SHOULD, 2],
      [COULD, 1],
    ]);
    expect(a.targets[0].proposers.map((p) => p.userName)).toEqual(["rick", "dana"]);
    expect(a.targets[1].proposers.map((p) => p.userName)).toEqual(["sam"]);
  });

  it("reports the current official value, not the fromValue snapshot", () => {
    // A facilitator has already reconciled obj-b to COULD, so the snapshot taken
    // at proposal time (SHOULD) is stale. Showing the snapshot as "current"
    // would tell the room the move still needs making when it already has.
    const tallies = tallyByObject(
      [{ objectId: "obj-b", title: "Savings hub", currentValue: COULD }],
      [proposal("obj-b", "rick", COULD, SHOULD)]
    );
    expect(tallies[0].currentValue).toBe(COULD);
  });

  it("leaves an object with no proposals empty rather than inventing agreement", () => {
    const tallies = tallyByObject(objects, [proposal("obj-a", "rick", SHOULD, MUST)]);
    const c = tallies.find((t) => t.objectId === "obj-c")!;

    expect(c.proposalCount).toBe(0);
    expect(c.distinctTargetCount).toBe(0);
    expect(c.targets).toEqual([]);
    expect(c.unanimousMove).toBe(false);
    // The sparse-delta invariant, asserted structurally: no field on the rollup
    // may carry a count of people who did NOT propose. If someone adds an
    // "agreed"/"agreementCount"/"keepCount" field, this fails and they have to
    // come read the invariant comment in lib/card-sort-tally.ts.
    expect(Object.keys(c).sort()).toEqual(
      [
        "currentValue",
        "distinctTargetCount",
        "objectId",
        "proposalCount",
        "targets",
        "title",
        "unanimousMove",
      ].sort()
    );
  });

  it("flags unanimous movement, which is the opposite of contested", () => {
    const tallies = tallyByObject(
      [{ objectId: "obj-a", title: "Rate table redesign", currentValue: MUST }],
      [
        proposal("obj-a", "rick", WONT, MUST),
        proposal("obj-a", "dana", WONT, MUST),
        proposal("obj-a", "sam", WONT, MUST),
      ]
    );
    expect(tallies[0].unanimousMove).toBe(true);
    expect(tallies[0].distinctTargetCount).toBe(1);
  });

  it("does not call a single lone proposal unanimous", () => {
    const tallies = tallyByObject(
      [{ objectId: "obj-a", title: "Rate table redesign", currentValue: MUST }],
      [proposal("obj-a", "rick", WONT, MUST)]
    );
    // One person is not a consensus. Labelling it unanimous would let a single
    // opinion read as the room's verdict.
    expect(tallies[0].unanimousMove).toBe(false);
  });

  it("ignores proposals for objects outside the supplied list", () => {
    const tallies = tallyByObject(
      [{ objectId: "obj-a", title: "Rate table redesign", currentValue: MUST }],
      [proposal("obj-a", "rick", SHOULD, MUST), proposal("obj-zzz", "dana", SHOULD, MUST)]
    );
    expect(tallies).toHaveLength(1);
    expect(tallies[0].proposalCount).toBe(1);
  });
});

describe("rankContested", () => {
  it("ranks disagreement above raw volume", () => {
    const objects: TallyObject[] = [
      { objectId: "split", title: "Split three ways", currentValue: MUST },
      { objectId: "popular", title: "Everyone agrees to move", currentValue: MUST },
    ];
    const tallies = tallyByObject(objects, [
      // 3 proposals, 3 different targets.
      proposal("split", "rick", SHOULD, MUST),
      proposal("split", "dana", COULD, MUST),
      proposal("split", "sam", WONT, MUST),
      // 5 proposals, all the same target. More volume, zero disagreement.
      proposal("popular", "rick", WONT, MUST),
      proposal("popular", "dana", WONT, MUST),
      proposal("popular", "sam", WONT, MUST),
      proposal("popular", "ali", WONT, MUST),
      proposal("popular", "jo", WONT, MUST),
    ]);

    const ranked = rankContested(tallies);
    expect(ranked.map((t) => t.objectId)).toEqual(["split", "popular"]);
  });

  it("breaks ties on total proposal count", () => {
    const objects: TallyObject[] = [
      { objectId: "loud", title: "Loud", currentValue: MUST },
      { objectId: "quiet", title: "Quiet", currentValue: MUST },
    ];
    const tallies = tallyByObject(objects, [
      proposal("loud", "rick", SHOULD, MUST),
      proposal("loud", "dana", SHOULD, MUST),
      proposal("loud", "sam", COULD, MUST),
      proposal("quiet", "rick", SHOULD, MUST),
      proposal("quiet", "dana", COULD, MUST),
    ]);
    const ranked = rankContested(tallies);
    // Both have 2 distinct targets; "loud" has 3 proposals to "quiet"'s 2.
    expect(ranked.map((t) => t.distinctTargetCount)).toEqual([2, 2]);
    expect(ranked.map((t) => t.objectId)).toEqual(["loud", "quiet"]);
  });

  it("excludes objects nobody proposed on instead of ranking them zero", () => {
    const objects: TallyObject[] = [
      { objectId: "obj-a", title: "Proposed on", currentValue: MUST },
      { objectId: "obj-b", title: "Untouched", currentValue: MUST },
    ];
    const ranked = rankContested(tallyByObject(objects, [proposal("obj-a", "rick", SHOULD, MUST)]));
    expect(ranked.map((t) => t.objectId)).toEqual(["obj-a"]);
  });

  it("does not mutate its input", () => {
    const tallies = tallyByObject(
      [
        { objectId: "a", title: "A", currentValue: MUST },
        { objectId: "b", title: "B", currentValue: MUST },
      ],
      [
        proposal("b", "rick", SHOULD, MUST),
        proposal("b", "dana", COULD, MUST),
        proposal("a", "sam", SHOULD, MUST),
      ]
    );
    const before = tallies.map((t) => t.objectId);
    rankContested(tallies);
    expect(tallies.map((t) => t.objectId)).toEqual(before);
  });

  it("states its own definition, so the UI can render the rule it implements", () => {
    expect(CONTESTED_DEFINITION).toMatch(/number of different buckets/i);
    expect(CONTESTED_DEFINITION).toMatch(/NOT contested/);
  });
});

describe("computeNetFlow", () => {
  it("counts directional movement between buckets", () => {
    const flow = computeNetFlow(
      [
        proposal("a", "rick", SHOULD, MUST),
        proposal("b", "dana", SHOULD, MUST),
        proposal("c", "sam", MUST, SHOULD),
      ],
      MOSCOW
    );

    const mustToShould = flow.edges.find((e) => e.from === MUST && e.to === SHOULD)!;
    expect(mustToShould.count).toBe(2);
    const shouldToMust = flow.edges.find((e) => e.from === SHOULD && e.to === MUST)!;
    expect(shouldToMust.count).toBe(1);

    const must = flow.buckets.find((b) => b.value === MUST)!;
    expect(must).toMatchObject({ inflow: 1, outflow: 2, net: -1 });
    const should = flow.buckets.find((b) => b.value === SHOULD)!;
    expect(should).toMatchObject({ inflow: 2, outflow: 1, net: 1 });
  });

  it("nets to zero across buckets when every proposal has a source bucket", () => {
    const flow = computeNetFlow(
      [
        proposal("a", "rick", SHOULD, MUST),
        proposal("b", "dana", COULD, SHOULD),
        proposal("c", "sam", WONT, COULD),
      ],
      MOSCOW
    );
    expect(flow.buckets.reduce((sum, b) => sum + b.net, 0)).toBe(0);
    expect(flow.fromUnsetCount).toBe(0);
  });

  it("treats a null fromValue as inflow with no source bucket", () => {
    const flow = computeNetFlow(
      [proposal("a", "rick", MUST, null), proposal("b", "dana", SHOULD, MUST)],
      MOSCOW
    );

    expect(flow.fromUnsetCount).toBe(1);
    const must = flow.buckets.find((b) => b.value === MUST)!;
    // Gains one from the unset object, loses one to SHOULD.
    expect(must).toMatchObject({ inflow: 1, outflow: 1, net: 0 });
    // No bucket absorbs the unset outflow, so the totals are deliberately
    // asymmetric by exactly fromUnsetCount rather than silently balanced.
    expect(flow.buckets.reduce((sum, b) => sum + b.net, 0)).toBe(flow.fromUnsetCount);
    expect(flow.edges.some((e) => e.from === null && e.to === MUST)).toBe(true);
  });

  it("lists every declared bucket even at zero flow", () => {
    const flow = computeNetFlow([proposal("a", "rick", SHOULD, MUST)], MOSCOW);
    expect(flow.buckets.map((b) => b.value)).toEqual(MOSCOW.map((o) => o.value));
    expect(flow.buckets.find((b) => b.value === WONT)).toMatchObject({
      inflow: 0,
      outflow: 0,
      net: 0,
    });
  });

  it("keeps proposals naming an option the field no longer declares", () => {
    // A stale value is still someone's recorded opinion. Dropping it would make
    // the edge counts and the bucket totals disagree with each other.
    const flow = computeNetFlow([proposal("a", "rick", "retired_bucket", MUST)], MOSCOW);
    const stale = flow.buckets.find((b) => b.value === "retired_bucket")!;
    expect(stale.inflow).toBe(1);
    // Appended after the declared options rather than interleaved.
    expect(flow.buckets.at(-1)!.value).toBe("retired_bucket");
  });

  it("works on a factor with no shared option set and unrelated values", () => {
    // Generality check at the math layer: Quarter, 4 local options, nothing
    // MoSCoW about it. Same functions, no special-casing.
    const quarters: SelectOption[] = [
      { label: "Q1", value: "q1" },
      { label: "Q2", value: "q2" },
      { label: "Q3", value: "q3" },
      { label: "Q4", value: "q4" },
    ];
    const flow = computeNetFlow(
      [proposal("a", "rick", "q3", "q1"), proposal("b", "dana", "q3", "q2")],
      quarters
    );
    expect(flow.buckets.find((b) => b.value === "q3")).toMatchObject({ inflow: 2, net: 2 });
    expect(flow.buckets.map((b) => b.value)).toEqual(["q1", "q2", "q3", "q4"]);
  });
});
