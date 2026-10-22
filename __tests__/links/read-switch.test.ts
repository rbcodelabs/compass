/**
 * readByFamilyMode (lib/links/read-switch.ts): the one place a legacy reader consults its family's read flag.
 * off: legacy only, the compare module is never loaded. shadow: legacy result returned unchanged whatever the comparison does.
 * on: the entity_links result is served; if it throws, legacy serves the request and the error is recorded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const compare = vi.hoisted(() => ({
  loaded: 0,
  compareFamilyRead: vi.fn(async (..._args: unknown[]) => null as unknown),
  recordReadError: vi.fn((..._args: unknown[]) => {}),
}));
vi.mock("@/lib/links/read-compare", () => {
  compare.loaded += 1;
  return { compareFamilyRead: compare.compareFamilyRead, recordReadError: compare.recordReadError };
});

const FLAG = "COMPASS_ENTITY_LINKS_ARTIFACT_READ";
type Switch = typeof import("@/lib/links/read-switch");
let readByFamilyMode: Switch["readByFamilyMode"];

beforeEach(async () => {
  vi.resetModules();
  compare.loaded = 0;
  compare.compareFamilyRead.mockClear();
  compare.recordReadError.mockClear();
  ({ readByFamilyMode } = await import("@/lib/links/read-switch"));
});
afterEach(() => vi.unstubAllEnvs());

const LEGACY = { source: "legacy" };
const ENTITY = { source: "entity_links" };
const readers = (overrides: Partial<Parameters<Switch["readByFamilyMode"]>[1]> = {}) => ({
  legacy: vi.fn(async () => LEGACY),
  shadowScope: vi.fn(() => ({ legacy: [], readEntityLinks: async () => [] })),
  entityLinks: vi.fn(async () => ENTITY),
  ...overrides,
}) as unknown as {
  legacy: ReturnType<typeof vi.fn> & (() => Promise<unknown>);
  shadowScope: ReturnType<typeof vi.fn> & ((result: unknown) => ReturnType<Parameters<Switch["readByFamilyMode"]>[1]["shadowScope"]>);
  entityLinks: ReturnType<typeof vi.fn> & (() => Promise<unknown>);
};

describe("readByFamilyMode: off", () => {
  it.each([undefined, "off", "ON", "garbage"])("flag %s: only legacy runs and read-compare is never imported or called", async (value) => {
    if (value !== undefined) vi.stubEnv(FLAG, value);
    const r = readers();
    expect(await readByFamilyMode("ARTIFACT", r)).toBe(LEGACY);
    expect(r.legacy).toHaveBeenCalledTimes(1);
    expect(r.shadowScope).not.toHaveBeenCalled();
    expect(r.entityLinks).not.toHaveBeenCalled();
    expect(compare.loaded).toBe(0);
    expect(compare.compareFamilyRead).not.toHaveBeenCalled();
    expect(compare.recordReadError).not.toHaveBeenCalled();
  });

  it("a legacy failure propagates to the caller", async () => {
    const r = readers({ legacy: vi.fn(async () => { throw new Error("legacy down") }) });
    await expect(readByFamilyMode("ARTIFACT", r)).rejects.toThrow("legacy down");
  });

  it("another family's flag does not enable this family", async () => {
    vi.stubEnv("COMPASS_ENTITY_LINKS_TASK_READ", "on");
    const r = readers();
    expect(await readByFamilyMode("ARTIFACT", r)).toBe(LEGACY);
    expect(r.entityLinks).not.toHaveBeenCalled();
  });
});

describe("readByFamilyMode: shadow", () => {
  beforeEach(() => vi.stubEnv(FLAG, "shadow"));

  it("returns the legacy result (same reference), compares afterwards, and never calls entityLinks", async () => {
    const scope = { legacy: [], readEntityLinks: async () => [] };
    const r = readers({ shadowScope: vi.fn(() => scope) });
    expect(await readByFamilyMode("ARTIFACT", r)).toBe(LEGACY);
    expect(r.shadowScope).toHaveBeenCalledWith(LEGACY);
    expect(compare.compareFamilyRead).toHaveBeenCalledWith("ARTIFACT", { legacy: scope.legacy, readEntityLinks: scope.readEntityLinks });
    expect(r.entityLinks).not.toHaveBeenCalled();
    expect(compare.recordReadError).not.toHaveBeenCalled();
  });

  it("a null shadow scope skips the comparison and still returns legacy", async () => {
    const r = readers({ shadowScope: vi.fn(() => null) });
    expect(await readByFamilyMode("ARTIFACT", r)).toBe(LEGACY);
    expect(compare.compareFamilyRead).not.toHaveBeenCalled();
  });

  it("shadowScope throwing (sync) is swallowed, recorded, and legacy is returned unchanged", async () => {
    const boom = new Error("scope failed");
    const r = readers({ shadowScope: vi.fn(() => { throw boom }) });
    expect(await readByFamilyMode("ARTIFACT", r)).toBe(LEGACY);
    expect(compare.recordReadError).toHaveBeenCalledWith("ARTIFACT", boom);
  });

  it("shadowScope rejecting (async) is swallowed, recorded, and legacy is returned unchanged", async () => {
    const boom = new Error("scope rejected");
    const r = readers({ shadowScope: vi.fn(async () => { throw boom }) });
    expect(await readByFamilyMode("ARTIFACT", r)).toBe(LEGACY);
    expect(compare.recordReadError).toHaveBeenCalledWith("ARTIFACT", boom);
  });

  it("readEntityLinks throwing inside the comparison is swallowed, recorded, and legacy is returned unchanged", async () => {
    const boom = new Error("entity_links read failed");
    const failing = { legacy: [], readEntityLinks: async () => { throw boom } };
    // The real compareFamilyRead swallows its own reader errors; model a compare that lets it escape to prove read-switch is the backstop.
    compare.compareFamilyRead.mockImplementationOnce(async (...args: unknown[]) => { await (args[1] as typeof failing).readEntityLinks() });
    const r = readers({ shadowScope: vi.fn(() => failing) });
    expect(await readByFamilyMode("ARTIFACT", r)).toBe(LEGACY);
    expect(compare.recordReadError).toHaveBeenCalledWith("ARTIFACT", boom);
  });

  it("compareFamilyRead rejecting is swallowed and recorded", async () => {
    const boom = new Error("compare failed");
    compare.compareFamilyRead.mockRejectedValueOnce(boom);
    expect(await readByFamilyMode("ARTIFACT", readers())).toBe(LEGACY);
    expect(compare.recordReadError).toHaveBeenCalledWith("ARTIFACT", boom);
  });

  it("a legacy failure still propagates (shadow never masks the source of truth)", async () => {
    const r = readers({ legacy: vi.fn(async () => { throw new Error("legacy down") }) });
    await expect(readByFamilyMode("ARTIFACT", r)).rejects.toThrow("legacy down");
    expect(compare.compareFamilyRead).not.toHaveBeenCalled();
  });
});

describe("readByFamilyMode: on", () => {
  beforeEach(() => vi.stubEnv(FLAG, "on"));

  it("returns the entity_links result and does not run legacy", async () => {
    const r = readers();
    expect(await readByFamilyMode("ARTIFACT", r)).toBe(ENTITY);
    expect(r.legacy).not.toHaveBeenCalled();
    expect(compare.recordReadError).not.toHaveBeenCalled();
  });

  it("entityLinks throwing: the legacy result is served and the error is recorded", async () => {
    const boom = new Error("entity_links down");
    const r = readers({ entityLinks: vi.fn(async () => { throw boom }) });
    expect(await readByFamilyMode("ARTIFACT", r)).toBe(LEGACY);
    expect(r.legacy).toHaveBeenCalledTimes(1);
    expect(compare.recordReadError).toHaveBeenCalledWith("ARTIFACT", boom);
  });

  it("both sides failing surfaces the legacy error", async () => {
    const r = readers({ entityLinks: vi.fn(async () => { throw new Error("el") }), legacy: vi.fn(async () => { throw new Error("legacy") }) });
    await expect(readByFamilyMode("ARTIFACT", r)).rejects.toThrow("legacy");
  });
});
