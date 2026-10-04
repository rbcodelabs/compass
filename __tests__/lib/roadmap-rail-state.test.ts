import { describe, expect, it } from "vitest";
import {
  RAIL_COOKIE_NAME,
  RAIL_WIDE_MEDIA_QUERY,
  parseRailPreference,
  railCookieString,
  resolveRailOpen,
} from "@/lib/roadmap/rail-state";

describe("roadmap rail state", () => {
  it("parses only the two explicit values and treats anything else as no preference", () => {
    expect(parseRailPreference("open")).toBe("open");
    expect(parseRailPreference("closed")).toBe("closed");
    for (const junk of [undefined, null, "", "OPEN", "true", "1", "open;", "{}"]) expect(parseRailPreference(junk)).toBeNull();
  });

  it("writes a cookie-safe, year-long, path-wide value that parses back", () => {
    const cookie = railCookieString("closed");
    expect(cookie).toContain(`${RAIL_COOKIE_NAME}=closed`);
    expect(cookie).toContain("path=/");
    expect(cookie).toMatch(/max-age=\d{7,}/);
    expect(parseRailPreference(cookie.split(";")[0].split("=")[1])).toBe("closed");
  });

  it("uses the wide breakpoint the layout uses", () => {
    expect(RAIL_WIDE_MEDIA_QUERY).toBe("(min-width: 1320px)");
  });

  it("defaults open on wide screens, closed when stacked, and open for an empty roadmap", () => {
    expect(resolveRailOpen({ preference: null, wide: true, empty: false })).toBe(true);
    expect(resolveRailOpen({ preference: null, wide: false, empty: false })).toBe(false);
    expect(resolveRailOpen({ preference: null, wide: false, empty: true })).toBe(true);
  });

  it("lets an explicit choice override every default, including the empty roadmap", () => {
    expect(resolveRailOpen({ preference: "closed", wide: true, empty: false })).toBe(false);
    expect(resolveRailOpen({ preference: "closed", wide: false, empty: true })).toBe(false);
    expect(resolveRailOpen({ preference: "open", wide: false, empty: false })).toBe(true);
  });
});
