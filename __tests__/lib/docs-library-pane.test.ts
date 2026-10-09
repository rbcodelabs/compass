/**
 * Unit coverage for lib/docs-library-pane.ts. The value crosses the
 * `document.cookie` (client write) / `cookies()` (server read) boundary and is
 * parsed during a server render, so the properties that matter are
 * failure-mode ones: corrupt input degrades to the default and never throws.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_DOCS_LIBRARY_STATE,
  DOCS_LIBRARY_COOKIE_MAX_AGE,
  DOCS_LIBRARY_COOKIE_NAME,
  DOCS_LIBRARY_WIDTH_DEFAULT,
  DOCS_LIBRARY_WIDTH_MAX,
  DOCS_LIBRARY_WIDTH_MIN,
  clampDocsLibraryWidth,
  docsLibraryCookieString,
  parseDocsLibraryState,
  serializeDocsLibraryState,
} from "@/lib/docs-library-pane";

describe("clampDocsLibraryWidth", () => {
  it("passes through a width inside the range", () => {
    expect(clampDocsLibraryWidth(300)).toBe(300);
  });

  it("clamps at both bounds", () => {
    expect(clampDocsLibraryWidth(0)).toBe(DOCS_LIBRARY_WIDTH_MIN);
    expect(clampDocsLibraryWidth(-50)).toBe(DOCS_LIBRARY_WIDTH_MIN);
    expect(clampDocsLibraryWidth(9000)).toBe(DOCS_LIBRARY_WIDTH_MAX);
  });

  it("rounds fractional widths", () => {
    expect(clampDocsLibraryWidth(300.6)).toBe(301);
  });

  it("turns non-finite input into the default", () => {
    expect(clampDocsLibraryWidth(NaN)).toBe(DOCS_LIBRARY_WIDTH_DEFAULT);
    expect(clampDocsLibraryWidth(Infinity)).toBe(DOCS_LIBRARY_WIDTH_DEFAULT);
  });
});

describe("parseDocsLibraryState", () => {
  it("parses open and collapsed values", () => {
    expect(parseDocsLibraryState("0:320")).toEqual({ collapsed: false, width: 320 });
    expect(parseDocsLibraryState("1:260")).toEqual({ collapsed: true, width: 260 });
  });

  it("clamps an out-of-range stored width", () => {
    expect(parseDocsLibraryState("0:9999")).toEqual({
      collapsed: false,
      width: DOCS_LIBRARY_WIDTH_MAX,
    });
    expect(parseDocsLibraryState("0:5")).toEqual({
      collapsed: false,
      width: DOCS_LIBRARY_WIDTH_MIN,
    });
  });

  it.each([undefined, null, "", "garbage", ":300", "2:300", "0:", "0:abc", "0:-300", "0:12345", "0:3.5", "{\"a\":1}"])(
    "falls back to the default for %j",
    (raw) => {
      expect(parseDocsLibraryState(raw)).toEqual(DEFAULT_DOCS_LIBRARY_STATE);
    },
  );
});

describe("serialize / cookie string", () => {
  it("round-trips through parse", () => {
    const state = { collapsed: true, width: 333 };
    expect(parseDocsLibraryState(serializeDocsLibraryState(state))).toEqual(state);
  });

  it("clamps on the way out so a bad width never reaches the cookie", () => {
    expect(serializeDocsLibraryState({ collapsed: false, width: 99999 })).toBe(
      `0:${DOCS_LIBRARY_WIDTH_MAX}`,
    );
    expect(serializeDocsLibraryState({ collapsed: false, width: NaN })).toBe(
      `0:${DOCS_LIBRARY_WIDTH_DEFAULT}`,
    );
  });

  it("emits only cookie-safe characters in the value", () => {
    expect(serializeDocsLibraryState({ collapsed: true, width: 300 })).toMatch(/^[01]:\d+$/);
  });

  it("builds a durable, path-wide, Lax cookie", () => {
    const cookie = docsLibraryCookieString({ collapsed: false, width: 280 });
    expect(cookie).toContain(`${DOCS_LIBRARY_COOKIE_NAME}=0:280`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${DOCS_LIBRARY_COOKIE_MAX_AGE}`);
    expect(cookie).toContain("SameSite=Lax");
  });
});
