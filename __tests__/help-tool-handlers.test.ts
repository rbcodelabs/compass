/**
 * Unit tests for the Help MCP tool handlers (search_help / get_help).
 * These operate on the real docs/content/*.md corpus -- no Prisma mocking
 * needed, mirroring __tests__/docs.test.ts.
 */
import { describe, it, expect } from "vitest";
import { searchHelp, getHelp } from "@/lib/help-tool-handlers";

describe("searchHelp handler", () => {
  it("returns matches with a Path pointer and anchor for a heading-level query", async () => {
    const result = await searchHelp({ query: "Discovery Rail" });
    const text = result.content[0].text;
    expect(text).toContain("Discovery Rail");
    expect(text).toContain("Path: /help/02-discovery#discovery-rail");
  });

  it("respects an explicit limit", async () => {
    const result = await searchHelp({ query: "the", limit: 1 });
    const text = result.content[0].text;
    const bullets = text.match(/^• /gm) ?? [];
    expect(bullets.length).toBeLessThanOrEqual(1);
  });

  it("returns a not-found message for an unmatched query", async () => {
    const result = await searchHelp({ query: "zzzznonexistentqueryterm9999" });
    expect(result.content[0].text).toContain("No help docs found matching");
  });
});

describe("getHelp handler", () => {
  it("returns the full doc content for a resolvable topic", async () => {
    const result = await getHelp({ topic: "discovery" });
    const text = result.content[0].text;
    expect(text).toContain("# Discovery");
    expect(text).toContain("Path: /help/02-discovery");
    expect(text).toContain("## Discovery Rail");
  });

  it("returns a not-found message for an unresolvable topic", async () => {
    const result = await getHelp({ topic: "zzzznonexistenttopic9999" });
    expect(result.content[0].text).toContain("No help doc found for topic");
  });
});
