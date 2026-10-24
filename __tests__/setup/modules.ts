import { afterEach, vi } from "vitest"
import { moduleTestState, resetModuleTestState } from "../helpers/modules"
import { MODULE_KEYS, MODULE_REGISTRY, moduleDisabledMessage, resolveModules, type ModuleKey } from "@/lib/modules/registry"

/**
 * Global stubs so unit tests do not need a database for workspace modules or the feature-table probes. A test that exercises the real
 * implementations calls vi.unmock("@/lib/modules/server") / vi.unmock("@/lib/feature-tables") (see __tests__/modules/server.test.ts).
 */
const resolved = () => resolveModules(new Map(Object.entries(moduleTestState().modules)) as ReadonlyMap<string, boolean>)

vi.mock("@/lib/modules/server", async () => {
  const states = () => resolved()
  const enabled = async (_workspaceId: string, key: ModuleKey) => states()[key].enabled
  class ModuleDisabledError extends Error {
    readonly code = "MODULE_DISABLED"
    constructor(readonly moduleKey: ModuleKey, message = moduleDisabledMessage(moduleKey)) {
      super(message)
      this.name = "ModuleDisabledError"
    }
  }
  return {
    moduleDisabledMessage,
    ModuleDisabledError,
    isModuleEnabled: vi.fn(enabled),
    requireModule: vi.fn(async (workspaceId: string, key: ModuleKey, message?: string) => {
      if (!(await enabled(workspaceId, key))) throw new ModuleDisabledError(key, message)
    }),
    getWorkspaceModuleStates: vi.fn(async () => states()),
    enabledModuleKeys: vi.fn(async () => MODULE_KEYS.filter((key) => states()[key].enabled)),
    researchNavEnabled: vi.fn(async () => states().research_capture.enabled),
    describeModules: vi.fn(async () => MODULE_KEYS.map((key) => ({
      key, label: MODULE_REGISTRY[key].label, description: MODULE_REGISTRY[key].description, group: MODULE_REGISTRY[key].group,
      sensitive: MODULE_REGISTRY[key].sensitive === true, enabled: states()[key].enabled, selected: states()[key].selected,
      explicit: states()[key].stored, defaultEnabled: MODULE_REGISTRY[key].defaultEnabled,
      requires: MODULE_REGISTRY[key].requires.map((requirement) => ({ key: requirement, label: MODULE_REGISTRY[requirement].label, enabled: states()[requirement].enabled })),
      blockedBy: states()[key].blockedBy,
    }))),
    setWorkspaceModule: vi.fn(async () => []),
  }
})

vi.mock("@/lib/feature-tables", () => ({
  followingTablesExist: vi.fn(async () => moduleTestState().tables.following),
  workspaceUpdatesTablesExist: vi.fn(async () => moduleTestState().tables.updates),
  resetFeatureTablesCache: vi.fn(),
}))

afterEach(() => resetModuleTestState())
