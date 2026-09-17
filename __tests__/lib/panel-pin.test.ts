/**
 * Unit coverage for lib/panel-pin.ts — the pure persistence layer behind
 * pinned detail panels.
 *
 * The properties that matter here are all failure-mode properties: this value
 * round-trips through a cookie, which means it crosses the
 * `document.cookie` (write, client) / `cookies()` (read, server) boundary and
 * can come back hand-edited, truncated, or absent. A corrupt cookie must
 * degrade to "unpinned, default width" and must never throw, because it is
 * read during a server render — a throw there is a 500 on a page that has
 * nothing to do with panel pinning.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PANEL_PIN,
  PANEL_IDS,
  PANEL_PIN_COOKIE_MAX_AGE,
  PANEL_WIDTH_DEFAULT,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
  clampPanelWidth,
  isPanelId,
  panelPinCookieName,
  panelPinCookieString,
  panelPinFromCookieValue,
  parsePanelPin,
  serializePanelPin,
} from "@/lib/panel-pin";

describe("clampPanelWidth", () => {
  it("passes through a width inside the range", () => {
    expect(clampPanelWidth(500)).toBe(500);
  });

  it("clamps at both bounds", () => {
    expect(clampPanelWidth(PANEL_WIDTH_MIN - 1)).toBe(PANEL_WIDTH_MIN);
    expect(clampPanelWidth(0)).toBe(PANEL_WIDTH_MIN);
    expect(clampPanelWidth(-9000)).toBe(PANEL_WIDTH_MIN);
    expect(clampPanelWidth(PANEL_WIDTH_MAX + 1)).toBe(PANEL_WIDTH_MAX);
    expect(clampPanelWidth(9000)).toBe(PANEL_WIDTH_MAX);
  });

  it("rounds fractional widths (a pointer delta is not an integer)", () => {
    expect(clampPanelWidth(500.4)).toBe(500);
    expect(clampPanelWidth(500.6)).toBe(501);
  });

  it("falls back to the default for non-finite input instead of throwing", () => {
    expect(clampPanelWidth(Number.NaN)).toBe(PANEL_WIDTH_DEFAULT);
    expect(clampPanelWidth(Number.POSITIVE_INFINITY)).toBe(PANEL_WIDTH_DEFAULT);
    expect(clampPanelWidth(Number.NEGATIVE_INFINITY)).toBe(PANEL_WIDTH_DEFAULT);
  });
});

describe("parsePanelPin", () => {
  it("round-trips every value serializePanelPin can produce", () => {
    for (const pinned of [true, false]) {
      for (const width of [PANEL_WIDTH_MIN, PANEL_WIDTH_DEFAULT, 517, PANEL_WIDTH_MAX]) {
        const pin = { pinned, width };
        expect(parsePanelPin(serializePanelPin(pin))).toEqual(pin);
      }
    }
  });

  it("returns the default for an absent cookie — this is the load-bearing default", () => {
    expect(parsePanelPin(undefined)).toEqual(DEFAULT_PANEL_PIN);
    expect(parsePanelPin(null)).toEqual(DEFAULT_PANEL_PIN);
    expect(parsePanelPin("")).toEqual(DEFAULT_PANEL_PIN);
    expect(DEFAULT_PANEL_PIN).toEqual({ pinned: false, width: PANEL_WIDTH_DEFAULT });
  });

  it("returns the default for malformed input without throwing", () => {
    const malformed = [
      "1",
      ":",
      ":448",
      "1:",
      "2:448", // flag out of range
      "-1:448",
      "true:448", // JSON-ish flag
      "1:448:9", // extra segment
      "1:4a8",
      "1:-448",
      "1:44.8",
      "1:12345", // more than 4 digits
      '{"pinned":true,"width":448}', // the JSON shape this format deliberately avoids
      "%7B%22pinned%22%3Atrue%7D", // URI-encoded JSON
      "1;448",
      "1 448",
      "   ",
    ];
    for (const raw of malformed) {
      expect(() => parsePanelPin(raw)).not.toThrow();
      expect(parsePanelPin(raw), `raw=${raw}`).toEqual(DEFAULT_PANEL_PIN);
    }
  });

  it("clamps an out-of-range width from a hand-edited cookie", () => {
    expect(parsePanelPin("1:9000")).toEqual({ pinned: true, width: PANEL_WIDTH_MAX });
    expect(parsePanelPin("1:0001")).toEqual({ pinned: true, width: PANEL_WIDTH_MIN });
    expect(parsePanelPin("0:9999")).toEqual({ pinned: false, width: PANEL_WIDTH_MAX });
  });
});

describe("serializePanelPin — cookie safety", () => {
  it("emits only cookie-safe characters, for every width in range", () => {
    for (let width = PANEL_WIDTH_MIN - 50; width <= PANEL_WIDTH_MAX + 50; width += 7) {
      for (const pinned of [true, false]) {
        const value = serializePanelPin({ pinned, width });
        expect(value, `width=${width}`).toMatch(/^[01]:\d+$/);
        expect(value).not.toMatch(/[;,\s"'\\=]/);
        // The whole reason this is not JSON: every character is already a
        // bare RFC 6265 cookie-octet, so nothing has to be encoded and the
        // client write and the server read cannot disagree about whether
        // anything was. (`:` is a legal cookie-octet — 0x3A — even though
        // encodeURIComponent would escape it.)
        expect(value).toMatch(/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/);
      }
    }
  });

  it("clamps on the way out so a bad in-memory width can never reach the cookie", () => {
    expect(serializePanelPin({ pinned: true, width: 9000 })).toBe(`1:${PANEL_WIDTH_MAX}`);
    expect(serializePanelPin({ pinned: false, width: Number.NaN })).toBe(`0:${PANEL_WIDTH_DEFAULT}`);
  });
});

describe("panelPinCookieName / panelPinCookieString", () => {
  it("names one cookie per panel id, all distinct", () => {
    const names = PANEL_IDS.map(panelPinCookieName);
    expect(new Set(names).size).toBe(PANEL_IDS.length);
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9_]+$/);
    expect(panelPinCookieName("detail")).toBe("compass_panel_detail");
  });

  it("keeps Phase 2's panel ids reserved so their cookies are purely additive", () => {
    expect(PANEL_IDS).toContain("detail");
    expect(PANEL_IDS).toContain("docsComments");
    expect(PANEL_IDS).toContain("docsHistory");
  });

  it("builds a complete, attribute-safe Set-Cookie value", () => {
    const cookie = panelPinCookieString("detail", { pinned: true, width: 512 });
    expect(cookie).toBe(
      `compass_panel_detail=1:512; Path=/; Max-Age=${PANEL_PIN_COOKIE_MAX_AGE}; SameSite=Lax`,
    );
  });
});

describe("isPanelId / panelPinFromCookieValue", () => {
  it("recognises exactly the known ids", () => {
    expect(isPanelId("detail")).toBe(true);
    expect(isPanelId("docsComments")).toBe(true);
    expect(isPanelId("nope")).toBe(false);
    expect(isPanelId("")).toBe(false);
  });

  it("falls back to the default for an unknown panel id without throwing", () => {
    expect(() => panelPinFromCookieValue("nope", "1:512")).not.toThrow();
    expect(panelPinFromCookieValue("nope", "1:512")).toEqual(DEFAULT_PANEL_PIN);
    expect(panelPinFromCookieValue("", "1:512")).toEqual(DEFAULT_PANEL_PIN);
  });

  it("parses normally for a known panel id", () => {
    expect(panelPinFromCookieValue("detail", "1:512")).toEqual({ pinned: true, width: 512 });
    expect(panelPinFromCookieValue("detail", undefined)).toEqual(DEFAULT_PANEL_PIN);
  });
});
