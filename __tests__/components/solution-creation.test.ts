import { beforeEach, describe, expect, it, vi } from "vitest";

const createSolutionsBatch = vi.fn();
vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/actions", () => ({
  createSolutionsBatch: (...args: unknown[]) => createSolutionsBatch(...args),
}));

import {
  type ParentFailure,
  buildSolutionCreation,
  describeParentFailure,
  matchParentByTitle,
  submitSolutionDrafts,
  toSolutionBatchItem,
} from "@/components/solutions/solution-creation";

const PARENTS = [
  { value: "o1", label: "Onboarding" },
  { value: "o2", label: "Churn" },
  { value: "o3", label: "Twin" },
  { value: "o4", label: "Twin" },
];
const TERMS = {
  solution: { singular: "solution", plural: "solutions" },
  parentLabel: "Opportunity",
  parent: { singular: "opportunity", plural: "opportunities" },
};

beforeEach(() => createSolutionsBatch.mockReset());

describe("matchParentByTitle", () => {
  it("matches an exact title, ignoring surrounding whitespace", () => {
    expect(matchParentByTitle(PARENTS, "  Churn ")).toEqual({ ok: true, id: "o2" });
  });

  it("does not fuzzy-match: a different case or a prefix is missing", () => {
    expect(matchParentByTitle(PARENTS, "churn")).toMatchObject({ ok: false, reason: "missing" });
    expect(matchParentByTitle(PARENTS, "Onboard")).toMatchObject({ ok: false });
  });

  it("refuses an ambiguous title instead of picking one", () => {
    const result = matchParentByTitle(PARENTS, "Twin");
    expect(result).toEqual({ ok: false, reason: "ambiguous", text: "Twin", count: 2 });
    expect(describeParentFailure(result as ParentFailure, TERMS.parent)).toBe(
      '2 opportunities are titled "Twin". Leave this cell empty and choose one above.',
    );
  });
});

describe("solution creation config", () => {
  const creation = buildSolutionCreation(PARENTS, TERMS);

  it("describes a parent picker and has no status field (solutions start as IDEA)", () => {
    expect(creation.parent).toMatchObject({ label: "Opportunity", placeholder: "Choose an opportunity" });
    expect(creation.fields.map((field) => field.id)).toEqual(["title", "opportunity", "description"]);
    expect(creation.limits).toEqual({ maxItems: 100, maxBytes: 256 * 1024 });
  });

  it("words every message with the workspace's own labels", () => {
    const renamed = buildSolutionCreation(PARENTS, {
      solution: { singular: "bet", plural: "bets" },
      parentLabel: "Problem",
      parent: { singular: "problem", plural: "problems" },
    });
    expect(renamed.noun).toEqual({ singular: "bet", plural: "bets" });
    expect(renamed.parent?.placeholder).toBe("Choose a problem");
    expect(renamed.fields[1].label).toBe("Problem (optional)");
    expect(renamed.validate({ title: "A", opportunity: "", description: "", parent: "" }).opportunity).toMatch(/Choose a problem above/);
  });

  it("accepts a row with the chosen parent", () => {
    expect(creation.validate({ title: "A", opportunity: "", description: "", parent: "o1" })).toEqual({});
  });

  it("lets a typed Opportunity cell override the chosen parent", () => {
    expect(creation.validate({ title: "A", opportunity: "Churn", description: "", parent: "" })).toEqual({});
    expect(toSolutionBatchItem(PARENTS, { clientId: "c", values: { title: "A", opportunity: "Churn", description: "", parent: "o1" } }).parent).toEqual({
      id: "o2",
    });
  });

  it("reports a missing parent, a missing title and an unknown or ambiguous title per row", () => {
    expect(creation.validate({ title: "A", opportunity: "", description: "", parent: "" }).opportunity).toMatch(/Choose an opportunity/);
    expect(creation.validate({ title: " ", opportunity: "", description: "", parent: "o1" }).title).toBe("Add a title.");
    expect(creation.validate({ title: "A", opportunity: "Nope", description: "", parent: "o1" }).opportunity).toMatch(/No opportunity titled "Nope"/);
    expect(creation.validate({ title: "A", opportunity: "Twin", description: "", parent: "o1" }).opportunity).toMatch(/2 opportunities/);
  });

  it("rejects a chosen parent that is not an offered option", () => {
    expect(creation.validate({ title: "A", opportunity: "", description: "", parent: "foreign" }).opportunity).toMatch(/not available/);
  });

  it("caps the title at 255 characters", () => {
    expect(creation.validate({ title: "x".repeat(256), opportunity: "", description: "", parent: "o1" }).title).toMatch(/255/);
  });
});

describe("submitSolutionDrafts", () => {
  const slugs = { orgSlug: "acme", workspaceSlug: "product" };

  it("sends solution batch items and maps the server's parent error onto the Opportunity cell", async () => {
    createSolutionsBatch.mockResolvedValue({
      ok: true,
      results: [
        { clientId: "a", ok: true, id: "a" },
        { clientId: "b", ok: false, code: "NOT_FOUND", error: "That opportunity was not found in this workspace.", field: "parent" },
        { clientId: "c", ok: false, code: "INVALID", error: "Odd.", field: "unmapped" },
      ],
    });
    const items = ["a", "b", "c"].map((clientId) => ({
      clientId,
      values: { title: clientId, opportunity: "", description: "  ", parent: "o1" },
    }));
    const result = await submitSolutionDrafts(slugs, PARENTS, items);
    expect(createSolutionsBatch).toHaveBeenCalledWith("acme", "product", [
      { clientId: "a", title: "a", description: null, parent: { id: "o1" } },
      { clientId: "b", title: "b", description: null, parent: { id: "o1" } },
      { clientId: "c", title: "c", description: null, parent: { id: "o1" } },
    ]);
    expect(result).toEqual({
      ok: true,
      results: [
        { clientId: "a", ok: true, id: "a" },
        { clientId: "b", ok: false, code: "NOT_FOUND", error: "That opportunity was not found in this workspace.", field: "opportunity" },
        // An unknown server field falls back to a row-level error rather than a hidden cell.
        { clientId: "c", ok: false, code: "INVALID", error: "Odd.", field: undefined },
      ],
    });
  });

  it("passes a refused request through and refuses without a workspace", async () => {
    createSolutionsBatch.mockResolvedValue({ ok: false, error: "Too many." });
    expect(await submitSolutionDrafts(slugs, PARENTS, [])).toEqual({ ok: false, error: "Too many." });
    expect(await submitSolutionDrafts(null, PARENTS, [])).toMatchObject({ ok: false });
  });
});
