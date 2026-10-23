import { describe, expect, it } from "vitest"
import {
  MODULE_KEYS, MODULE_REGISTRY, ModuleToggleError, allDependents, allRequirements, moduleDisabledMessage, planModuleToggle, resolveModules,
} from "@/lib/modules/registry"

const stored = (entries: Record<string, boolean>) => new Map(Object.entries(entries))

describe("module registry", () => {
  it("keys the registry consistently and defaults everything off", () => {
    expect(Object.keys(MODULE_REGISTRY).sort()).toEqual([...MODULE_KEYS].sort())
    for (const key of MODULE_KEYS) {
      expect(MODULE_REGISTRY[key].key).toBe(key)
      expect(MODULE_REGISTRY[key].defaultEnabled).toBe(false)
    }
  })

  it("is acyclic and only requires registered modules", () => {
    for (const key of MODULE_KEYS) {
      expect(allRequirements(key)).not.toContain(key)
      for (const requirement of MODULE_REGISTRY[key].requires) expect(MODULE_KEYS).toContain(requirement)
    }
  })

  it("encodes the voice dependencies", () => {
    expect(allRequirements("research_voice_browser")).toEqual(["research_capture"])
    expect(allRequirements("research_voice_authoritative")).toEqual(["research_capture"])
    expect(allRequirements("research_voice_discovery").sort()).toEqual(["research_capture", "research_voice_authoritative"])
    expect(allDependents("research_capture").sort()).toEqual(["research_voice_authoritative", "research_voice_browser", "research_voice_discovery"])
  })

  it("names the fix in the disabled message", () => {
    expect(moduleDisabledMessage("research_capture")).toBe("Research capture is not enabled for this workspace. A workspace admin can enable it in Settings > Modules.")
  })
})

describe("resolveModules", () => {
  it("uses the default when no row exists", () => {
    const resolved = resolveModules(stored({}))
    expect(resolved.research_capture).toMatchObject({ enabled: false, selected: false, stored: false })
  })

  it("honors a stored row", () => {
    expect(resolveModules(stored({ research_capture: true })).research_capture).toMatchObject({ enabled: true, stored: true })
  })

  it("fails closed when a requirement is off, whatever the module's own row says", () => {
    const resolved = resolveModules(stored({ research_voice_browser: true }))
    expect(resolved.research_voice_browser).toMatchObject({ enabled: false, selected: true, blockedBy: ["research_capture"] })
  })

  it("applies requirements transitively", () => {
    const resolved = resolveModules(stored({ research_capture: true, research_voice_discovery: true }))
    expect(resolved.research_voice_discovery.enabled).toBe(false)
    expect(resolveModules(stored({ research_capture: true, research_voice_authoritative: true, research_voice_discovery: true })).research_voice_discovery.enabled).toBe(true)
  })

  it("ignores unknown stored keys", () => {
    expect(() => resolveModules(stored({ retired_module: true }))).not.toThrow()
  })
})

describe("planModuleToggle", () => {
  it("refuses an unknown key", () => {
    expect(() => planModuleToggle(stored({}), "nope", true)).toThrow(ModuleToggleError)
  })

  it("refuses to enable a module whose requirement is off, naming it", () => {
    expect(() => planModuleToggle(stored({}), "research_voice_browser", true)).toThrow(/Research capture/)
  })

  it("enables when requirements are on, and is a no-op when already on", () => {
    expect(planModuleToggle(stored({ research_capture: true }), "research_voice_browser", true)).toEqual([{ key: "research_voice_browser", enabled: true }])
    expect(planModuleToggle(stored({ research_capture: true, research_voice_browser: true }), "research_voice_browser", true)).toEqual([])
  })

  it("disabling cascades to selected dependents only", () => {
    const writes = planModuleToggle(stored({ research_capture: true, research_voice_browser: true }), "research_capture", false)
    expect(writes.map((w) => w.key).sort()).toEqual(["research_capture", "research_voice_browser"])
    expect(writes.every((w) => w.enabled === false)).toBe(true)
  })

  it("disabling a module that is already off writes nothing", () => {
    expect(planModuleToggle(stored({}), "research_capture", false)).toEqual([])
  })
})
