/**
 * Unit tests for lib/embed-auth-mode.ts — the type union and the two readers
 * built on it.
 *
 * No test file existed for this module before now; coverage of
 * resolveEmbedAuthMode's fail-closed behavior lived only indirectly, through
 * lib/embed-sources.ts's resolveEmbedToken tests. This file adds direct
 * coverage of the module's own exports, including the third mode
 * (PORTAL_SSO) added alongside INTERNAL_SSO and PORTAL.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_EMBED_AUTH_MODE,
  EMBED_AUTH_MODES,
  parseEmbedAuthMode,
  resolveEmbedAuthMode,
} from "@/lib/embed-auth-mode";

describe("EMBED_AUTH_MODES", () => {
  it("names exactly the three supported modes", () => {
    expect(EMBED_AUTH_MODES).toEqual(["INTERNAL_SSO", "PORTAL", "PORTAL_SSO"]);
  });

  it("keeps INTERNAL_SSO as the fail-safe default", () => {
    expect(DEFAULT_EMBED_AUTH_MODE).toBe("INTERNAL_SSO");
  });
});

describe("resolveEmbedAuthMode", () => {
  it("passes each real mode through unchanged", () => {
    expect(resolveEmbedAuthMode("INTERNAL_SSO")).toBe("INTERNAL_SSO");
    expect(resolveEmbedAuthMode("PORTAL")).toBe("PORTAL");
    expect(resolveEmbedAuthMode("PORTAL_SSO")).toBe("PORTAL_SSO");
  });

  it("resolves null, undefined, and an unrecognized value to the fail-safe default", () => {
    expect(resolveEmbedAuthMode(null)).toBe("INTERNAL_SSO");
    expect(resolveEmbedAuthMode(undefined)).toBe("INTERNAL_SSO");
    expect(resolveEmbedAuthMode("portal_sso")).toBe("INTERNAL_SSO");
    expect(resolveEmbedAuthMode("nonsense")).toBe("INTERNAL_SSO");
    expect(resolveEmbedAuthMode("")).toBe("INTERNAL_SSO");
  });
});

describe("parseEmbedAuthMode", () => {
  it("accepts each real mode", () => {
    expect(parseEmbedAuthMode("INTERNAL_SSO")).toBe("INTERNAL_SSO");
    expect(parseEmbedAuthMode("PORTAL")).toBe("PORTAL");
    expect(parseEmbedAuthMode("PORTAL_SSO")).toBe("PORTAL_SSO");
  });

  it("returns null for anything that is not a real mode, rather than rewriting it", () => {
    expect(parseEmbedAuthMode("portal_sso")).toBeNull();
    expect(parseEmbedAuthMode("nonsense")).toBeNull();
    expect(parseEmbedAuthMode(null)).toBeNull();
    expect(parseEmbedAuthMode(undefined)).toBeNull();
    expect(parseEmbedAuthMode(42)).toBeNull();
  });
});
