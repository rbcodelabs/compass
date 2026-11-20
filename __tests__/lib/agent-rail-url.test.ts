import { describe, expect, it } from "vitest";

import {
  applyRailParams,
  decodeRailParams,
  railUrlFor,
  type RailUrlState,
} from "@/lib/agent-rail-url";

const base: RailUrlState = { open: true, view: "agent", conversationId: null, helpArticle: null };
const params = (qs: string) => new URLSearchParams(qs);

describe("applyRailParams", () => {
  it("writes nothing for an open rail on a fresh agent chat", () => {
    expect(applyRailParams(params(""), base).toString()).toBe("");
  });

  it("never writes rc, and encodes a non-default view", () => {
    expect(applyRailParams(params(""), { ...base, conversationId: "abc-123" }).toString()).toBe("");
    expect(applyRailParams(params(""), { ...base, view: "library" }).toString()).toBe("rail=library");
  });

  it("does not write rc while another view is showing", () => {
    const next = applyRailParams(params(""), { ...base, view: "help", conversationId: "c1" });
    expect(next.get("rail")).toBe("help");
    expect(next.has("rc")).toBe(false);
  });

  it("encodes the help article with its anchor, only for the help view", () => {
    const help = { ...base, view: "help" as const, helpArticle: { slug: "04-roadmap", anchor: "horizons" } };
    expect(applyRailParams(params(""), help).get("ra")).toBe("04-roadmap#horizons");
    expect(applyRailParams(params(""), { ...help, view: "library" }).has("ra")).toBe(false);
  });

  it("strips every rail param when the rail is closed", () => {
    const current = params("rail=help&ra=x&detail=task%3A1");
    expect(applyRailParams(current, { ...base, open: false }).toString()).toBe("detail=task%3A1");
  });

  it("leaves a stray rc alone instead of owning it", () => {
    expect(applyRailParams(params("rc=c1"), base).toString()).toBe("rc=c1");
    expect(applyRailParams(params("rc=c1"), { ...base, open: false }).toString()).toBe("rc=c1");
  });

  it("composes with detail and filter params without disturbing them", () => {
    const current = params("detail=task%3Aabc&status=open");
    const next = applyRailParams(current, { ...base, conversationId: "new" });
    expect(next.get("detail")).toBe("task:abc");
    expect(next.get("status")).toBe("open");
    expect(next.has("rc")).toBe(false);
  });
});

describe("decodeRailParams", () => {
  it("returns null when no rail state is present", () => {
    expect(decodeRailParams(params("detail=task%3A1&c=abc"))).toBeNull();
  });

  it("does not treat rc as rail state", () => {
    expect(decodeRailParams(params("rc=c1"))).toBeNull();
    expect(decodeRailParams(params("rail=library&rc=c1"))?.conversationId).toBeNull();
  });

  it("opens the rail for any valid rail param", () => {
    expect(decodeRailParams(params("rail=library"))?.view).toBe("library");
  });

  it("implies the help view from an article", () => {
    expect(decodeRailParams(params("ra=04-roadmap%23horizons"))).toEqual({
      open: true,
      view: "help",
      conversationId: null,
      helpArticle: { slug: "04-roadmap", anchor: "horizons" },
    });
  });

  it("drops an article when another view is explicit", () => {
    expect(decodeRailParams(params("rail=library&ra=04-roadmap"))?.helpArticle).toBeNull();
  });

  it("rejects malformed values rather than opening on them", () => {
    expect(decodeRailParams(params("rail=bogus"))).toBeNull();
    expect(decodeRailParams(params("ra=a%2Fb"))).toBeNull();
  });

  it("round-trips through applyRailParams", () => {
    const states: RailUrlState[] = [
      base,
      { ...base, view: "library" },
      { ...base, view: "help", helpArticle: { slug: "13-tasks" } },
      { ...base, view: "help", helpArticle: { slug: "13-tasks", anchor: "a-b" } },
    ];
    for (const state of states) {
      const decoded = decodeRailParams(applyRailParams(params(""), state));
      // A default-state open rail leaves no params, so nothing to decode.
      if (state.view === "agent" && !state.conversationId) expect(decoded).toBeNull();
      else expect(decoded).toEqual(state);
    }
  });
});

describe("railUrlFor", () => {
  it("returns null when the URL already matches", () => {
    expect(railUrlFor("/a/b/roadmap", "?rail=library", "", { ...base, view: "library" })).toBeNull();
  });

  it("re-adds params onto a link-built URL, keeping hash and other params", () => {
    expect(railUrlFor("/a/b/okrs", "?q=1", "#top", { ...base, view: "help" })).toBe("/a/b/okrs?q=1&rail=help#top");
  });

  it("removes stale params when the rail closed", () => {
    expect(railUrlFor("/a/b/okrs", "?rail=help", "", { ...base, open: false })).toBe("/a/b/okrs");
  });
});
