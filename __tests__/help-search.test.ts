import { describe, it, expect } from "vitest";
import { searchHelp, getHelpTopic, getDocRaw, getDoc } from "@/lib/docs";

describe("searchHelp", () => {
  it("returns [] for an empty/blank query", () => {
    expect(searchHelp("")).toEqual([]);
    expect(searchHelp("   ")).toEqual([]);
  });

  it("finds a doc by a heading-level match and ranks it above unrelated docs", () => {
    const results = searchHelp("Discovery Rail");
    expect(results.length).toBeGreaterThan(0);
    const top = results[0];
    expect(top.slug).toBe("02-discovery");
    expect(top.heading).toBe("Discovery Rail");
  });

  it("returns an anchor that matches the actual heading id rendered by getDoc (rehype-slug)", async () => {
    const results = searchHelp("Discovery Rail");
    const top = results[0];
    expect(top.anchor).toBeTruthy();

    const doc = await getDoc("02-discovery");
    expect(doc).not.toBeNull();
    expect(doc!.html).toContain(`id="${top.anchor}"`);
  });

  it("ranks a title-word match's home doc highly", () => {
    const results = searchHelp("roadmap");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.slug === "04-roadmap")).toBe(true);
  });

  it("respects the limit parameter", () => {
    expect(searchHelp("roadmap", 10).length).toBeGreaterThan(2);
    expect(searchHelp("roadmap", 2)).toHaveLength(2);
  });

  it("returns [] for a query that matches nothing", () => {
    expect(searchHelp("zzzznonexistentqueryterm9999")).toEqual([]);
  });

  it("ranks the OKR cycle section first for a natural-language creation question", () => {
    const results = searchHelp("how do I create an OKR cycle");

    expect(results[0]).toMatchObject({
      slug: "01-okrs",
      anchor: "okr-cycles",
    });
  });

  it("ranks the roadmap promotion section first for a natural-language workflow question", () => {
    const results = searchHelp("how do I promote a solution to the roadmap");

    expect(results[0]).toMatchObject({
      slug: "04-roadmap",
      anchor: "not-yet-on-the-roadmap",
    });
  });

  it("returns [] when a query contains only question and filler stopwords", () => {
    expect(searchHelp("how do I the to")).toEqual([]);
  });

  it("ignores polite question filler when ranking a roadmap workflow query", () => {
    const results = searchHelp("could you please tell me how I promote a solution to the roadmap", 3);

    expect(results[0]).toMatchObject({
      slug: "04-roadmap",
      anchor: "not-yet-on-the-roadmap",
    });
  });

  it("removes one-character query terms", () => {
    expect(searchHelp("x")).toEqual([]);
  });

  it("suppresses duplicate query terms", () => {
    expect(searchHelp("roadmap roadmap")).toEqual(searchHelp("roadmap"));
  });

  it("caps each query term to one contribution per field", () => {
    const results = searchHelp("roadmap", 20);

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.score <= 8)).toBe(true);
  });

  it("keeps substring matching so singular terms match plural doc titles", () => {
    expect(searchHelp("experiment")[0]).toMatchObject({
      slug: "03-experiments",
      title: "Experiments",
      anchor: null,
      score: 8,
    });
  });
});

describe("getHelpTopic", () => {
  it("resolves an exact slug suffix to its doc", () => {
    const doc = getHelpTopic("discovery");
    expect(doc).not.toBeNull();
    expect(doc!.slug).toBe("02-discovery");
  });

  it("resolves a full doc-file slug", () => {
    const doc = getHelpTopic("09-mcp-api");
    expect(doc).not.toBeNull();
    expect(doc!.slug).toBe("09-mcp-api");
  });

  it("returns null for an unmatched topic", () => {
    expect(getHelpTopic("zzzznonexistenttopic9999")).toBeNull();
  });

  it("returns null for a blank topic", () => {
    expect(getHelpTopic("")).toBeNull();
  });
});

describe("getDocRaw", () => {
  it("returns the raw markdown body (not HTML) for a known slug", () => {
    const doc = getDocRaw("02-discovery");
    expect(doc).not.toBeNull();
    expect(doc!.title).toBe("Discovery");
    expect(doc!.content).toContain("## Discovery Rail");
    expect(doc!.content).not.toContain("<h2");
  });

  it("returns null for an unknown slug", () => {
    expect(getDocRaw("not-a-real-doc")).toBeNull();
  });
});
