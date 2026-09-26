import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppPrismaClient, AppTransactionClient } from "./db";
const readiness = vi.hoisted(() => ({
  findFirst: vi.fn().mockResolvedValue(null),
}));
vi.mock("./db", () => ({
  default: () => ({
    workspaceUpdatesState: readiness,
    workspaceUpdateEvent: readiness,
    workspaceUpdatesReadState: readiness,
  }),
}));
import { withToolTransaction } from "./mcp-tool-db";
import { withWorkspaceUpdates } from "./workspace-updates-capture";
afterEach(() => vi.unstubAllEnvs());
describe("Updates inside a PM tool transaction", () => {
  it("reuses the supplied receipt transaction without opening or replaying another transaction", async () => {
    vi.stubEnv("WORKSPACE_UPDATES_ENABLED", "1");
    const outer = { marker: "outer" } as unknown as AppTransactionClient;
    const nested = vi.fn();
    const original = { $transaction: nested } as unknown as AppPrismaClient;
    const result = await withToolTransaction(outer, () =>
      withWorkspaceUpdates(original, async (tx, capture) => ({
        same: tx === outer,
        capture,
      })),
    );
    expect(result).toEqual({ same: true, capture: true });
    expect(nested).not.toHaveBeenCalled();
  });
  it("leaves failure rollback to the outer transaction owner", async () => {
    vi.stubEnv("WORKSPACE_UPDATES_ENABLED", "1");
    const callback = vi.fn().mockRejectedValue({ code: "P2034" });
    await expect(
      withToolTransaction({} as AppTransactionClient, () =>
        withWorkspaceUpdates({} as AppPrismaClient, callback),
      ),
    ).rejects.toEqual({ code: "P2034" });
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
