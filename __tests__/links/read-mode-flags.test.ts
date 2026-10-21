/**
 * The per-family read flags (entity_links read flip, PR A). COMPASS_ENTITY_LINKS_<FAMILY>_READ = off | shadow | on, fail-closed:
 * only the exact strings "shadow" and "on" enable anything, and (unlike the *_MIRROR flags) the default is off outside production too.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LINK_READ_FAMILIES, LINK_READ_FLAG_NAMES, LINK_TYPES, effectiveLegacyMode, getLinkReadMode, linkTypesForEntity } from "@/lib/links/registry";

afterEach(() => vi.unstubAllEnvs());

describe("getLinkReadMode", () => {
  it("names one flag per family", () => {
    expect(LINK_READ_FLAG_NAMES).toEqual({
      SOLUTION_KR: "COMPASS_ENTITY_LINKS_SOLUTION_KR_READ",
      OPPORTUNITY: "COMPASS_ENTITY_LINKS_OPPORTUNITY_READ",
      ARTIFACT: "COMPASS_ENTITY_LINKS_ARTIFACT_READ",
      TASK: "COMPASS_ENTITY_LINKS_TASK_READ",
    });
  });

  it.each(LINK_READ_FAMILIES)("%s: unset is off outside production (no default-on like the mirror flags)", (family) => {
    expect(getLinkReadMode(family)).toBe("off");
  });

  it.each(LINK_READ_FAMILIES)("%s: off | shadow | on outside production, matched exactly (no trim or case folding)", (family) => {
    for (const value of ["off", "shadow", "on"] as const) {
      vi.stubEnv(LINK_READ_FLAG_NAMES[family], value);
      expect(getLinkReadMode(family)).toBe(value);
    }
    for (const value of ["  SHADOW ", "ON", "On", " on", "shadow "]) {
      vi.stubEnv(LINK_READ_FLAG_NAMES[family], value);
      expect(getLinkReadMode(family)).toBe("off");
    }
  });

  it.each(LINK_READ_FAMILIES)("%s: production is fail-closed, only the exact strings count", (family) => {
    vi.stubEnv("NODE_ENV", "production");
    expect(getLinkReadMode(family)).toBe("off");
    for (const value of ["", "1", "true", "ON", "Shadow", " on", "shadow ", "yes", "read", "enabled"]) {
      vi.stubEnv(LINK_READ_FLAG_NAMES[family], value);
      expect(getLinkReadMode(family)).toBe("off");
    }
    vi.stubEnv(LINK_READ_FLAG_NAMES[family], "shadow");
    expect(getLinkReadMode(family)).toBe("shadow");
    vi.stubEnv(LINK_READ_FLAG_NAMES[family], "on");
    expect(getLinkReadMode(family)).toBe("on");
  });

  it("flags are independent per family", () => {
    vi.stubEnv("COMPASS_ENTITY_LINKS_TASK_READ", "on");
    expect(getLinkReadMode("TASK")).toBe("on");
    expect(getLinkReadMode("ARTIFACT")).toBe("off");
    expect(getLinkReadMode("OPPORTUNITY")).toBe("off");
    expect(getLinkReadMode("SOLUTION_KR")).toBe("off");
  });
});

describe("effectiveLegacyMode", () => {
  const legacyDefs = Object.values(LINK_TYPES).filter((def) => def.legacy);

  it("is null for a type with no legacy adapter", () => {
    expect(effectiveLegacyMode(LINK_TYPES.EXPERIMENT_INFORMED_BY_STUDY)).toBeNull();
  });

  it.each(legacyDefs.map((def) => [def.key, def] as const))("%s: mirror by default, shadow / read from its family's flag", (_key, def) => {
    expect(effectiveLegacyMode(def)).toBe("mirror");
    vi.stubEnv(LINK_READ_FLAG_NAMES[def.legacy!.readFamily], "shadow");
    expect(effectiveLegacyMode(def)).toBe("shadow");
    vi.stubEnv(LINK_READ_FLAG_NAMES[def.legacy!.readFamily], "on");
    expect(effectiveLegacyMode(def)).toBe("read");
    vi.stubEnv(LINK_READ_FLAG_NAMES[def.legacy!.readFamily], "bogus");
    expect(effectiveLegacyMode(def)).toBe("mirror");
  });

  it("PR A changes no behaviour: the flags do not make a legacy type visible to the generic reads", () => {
    for (const family of LINK_READ_FAMILIES) vi.stubEnv(LINK_READ_FLAG_NAMES[family], "on");
    const visible = new Set(["OPPORTUNITY", "OBJECTIVE", "KEY_RESULT", "SOLUTION", "ARTIFACT", "TASK", "REVIEW_REQUEST"].flatMap((type) => linkTypesForEntity(type as never).map(({ def }) => def.key)));
    for (const def of legacyDefs) expect(visible.has(def.key)).toBe(false);
  });
});
