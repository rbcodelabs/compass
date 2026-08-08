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
    const results = searchHelp("the", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("returns [] for a query that matches nothing", () => {
    expect(searchHelp("zzzznonexistentqueryterm9999")).toEqual([]);
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
