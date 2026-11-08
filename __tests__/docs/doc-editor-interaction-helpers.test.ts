import { describe, expect, it } from "vitest";
import { BLOCK_COMMANDS, filterBlockCommands } from "@/components/docs/block-slash-menu";
import { normalizeLinkHref } from "@/components/docs/doc-bubble-menu";

describe("filterBlockCommands", () => {
  it("offers every block for an empty query", () => {
    expect(filterBlockCommands("")).toHaveLength(BLOCK_COMMANDS.length);
    expect(filterBlockCommands("  ")).toHaveLength(BLOCK_COMMANDS.length);
  });

  it("matches by label prefix, label word and keyword, case-insensitively", () => {
    expect(filterBlockCommands("head").map((c) => c.id)).toEqual(["h1", "h2", "h3"]);
    expect(filterBlockCommands("QUO").map((c) => c.id)).toEqual(["quote"]);
    expect(filterBlockCommands("list").map((c) => c.id)).toEqual(["bullets", "numbers"]);
    expect(filterBlockCommands("hr").map((c) => c.id)).toEqual(["divider"]);
    expect(filterBlockCommands("h2").map((c) => c.id)).toEqual(["h2"]);
  });

  it("returns nothing for a query that matches no block", () => {
    expect(filterBlockCommands("zzz")).toEqual([]);
  });
});

describe("normalizeLinkHref", () => {
  it("keeps allowed schemes and relative links", () => {
    expect(normalizeLinkHref("https://example.com/a")).toBe("https://example.com/a");
    expect(normalizeLinkHref("mailto:a@b.co")).toBe("mailto:a@b.co");
    expect(normalizeLinkHref("compass://task/1")).toBe("compass://task/1");
    expect(normalizeLinkHref("/docs/x")).toBe("/docs/x");
    expect(normalizeLinkHref("#section")).toBe("#section");
  });

  it("adds https to a bare domain", () => {
    expect(normalizeLinkHref("example.com")).toBe("https://example.com");
    expect(normalizeLinkHref("  example.com/path ")).toBe("https://example.com/path");
  });

  it("rejects empty input and unsafe schemes", () => {
    expect(normalizeLinkHref("")).toBeNull();
    expect(normalizeLinkHref("javascript:alert(1)")).toBeNull();
    expect(normalizeLinkHref("data:text/html,x")).toBeNull();
  });
});
