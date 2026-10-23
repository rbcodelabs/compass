import type { ModuleKey } from "@/lib/modules/registry"

/**
 * Per-test control of workspace modules and feature tables. The global test setup (__tests__/setup/modules.ts) replaces
 * lib/modules/server and lib/feature-tables with stubs that read this state, so tests never need a database for them.
 *
 * Defaults replicate the old test environment, where the product-feature environment variables were unset: research capture and PM
 * interviews on (they were "always on outside production"), everything else off. State resets after every test.
 */
export const DEFAULT_TEST_MODULES: Partial<Record<ModuleKey, boolean>> = { research_capture: true, pm_interview: true }

type State = { modules: Partial<Record<ModuleKey, boolean>>; tables: { following: boolean; updates: boolean } }
const KEY = Symbol.for("compass.test.modules")
const holder = globalThis as unknown as Record<symbol, State | undefined>

export function moduleTestState(): State {
  return (holder[KEY] ??= { modules: { ...DEFAULT_TEST_MODULES }, tables: { following: false, updates: false } })
}

export function resetModuleTestState() {
  holder[KEY] = undefined
}

/** Override stored module values for every workspace in this test. Dependencies still apply (fail closed), as in production. */
export function setModules(overrides: Partial<Record<ModuleKey, boolean>>) {
  Object.assign(moduleTestState().modules, overrides)
}

/** Declare which feature tables "exist" (lib/feature-tables.ts) for this test. */
export function setFeatureTables(tables: Partial<{ following: boolean; updates: boolean }>) {
  Object.assign(moduleTestState().tables, tables)
}
