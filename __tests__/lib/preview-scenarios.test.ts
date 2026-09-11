import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/seed-screenshots", () => ({
  seedSquads: vi.fn(),
  seedOkrCycleAndObjectives: vi.fn(),
  seedFullDemoData: vi.fn(),
}));

import { seedSquads, seedOkrCycleAndObjectives, seedFullDemoData } from "@/seed-screenshots";
import {
  applyPreviewScenario,
  isPreviewScenario,
  DEFAULT_PREVIEW_SCENARIO,
  PREVIEW_SCENARIOS,
  PREVIEW_SCENARIO_DESCRIPTIONS,
  type PreviewScenario,
} from "@/lib/preview-automation/scenarios";
import { bootstrapPreviewRun } from "@/lib/preview-automation/service";
import type { PreviewGrant } from "@/lib/preview-automation/grants";

const grant = { runId: "run", deploymentId: "deployment", nonce: "nonce", exp: 2000000000, operation: "bootstrap" } as PreviewGrant;

function fixture() {
  const tx = {
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    previewAutomationNonce: { create: vi.fn() },
    previewAutomationRun: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(({ data }) => data),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    organization: { create: vi.fn() }, workspace: { createMany: vi.fn() },
    user: { createMany: vi.fn() }, organizationMember: { createMany: vi.fn() }, workspaceMember: { createMany: vi.fn() },
    session: { create: vi.fn().mockImplementation(({ data }) => data) },
    previewAutomationSession: { create: vi.fn() },
  };
  return { tx, client: { $transaction: vi.fn(async (fn) => fn(tx)) } as unknown as PrismaClient };
}

beforeEach(() => vi.clearAllMocks());

describe("preview fixture scenarios", () => {
  it("only accepts identifiers from the closed catalog", () => {
    for (const scenario of PREVIEW_SCENARIOS) expect(isPreviewScenario(scenario)).toBe(true);
    for (const value of ["arbitrary", "", "DROP TABLE", 1, null, undefined, ["full-data"], { scenario: "full-data" }]) {
      expect(isPreviewScenario(value)).toBe(false);
    }
  });

  it("documents every catalog entry", () => {
    expect(Object.keys(PREVIEW_SCENARIO_DESCRIPTIONS).sort()).toEqual([...PREVIEW_SCENARIOS].sort());
  });

  it("defaults to a scenario that writes nothing", async () => {
    const { tx } = fixture();
    expect(isPreviewScenario(DEFAULT_PREVIEW_SCENARIO)).toBe(true);
    await applyPreviewScenario(tx as never, { schema: "s", workspaceId: "w", scenario: DEFAULT_PREVIEW_SCENARIO });
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(seedSquads).not.toHaveBeenCalled();
    expect(seedFullDemoData).not.toHaveBeenCalled();
  });

  it("seeds an OKR cycle without discovery or delivery work", async () => {
    const { tx } = fixture();
    await applyPreviewScenario(tx as never, { schema: "s", workspaceId: "w", scenario: "mid-okr-cycle" });
    expect(seedSquads).toHaveBeenCalledWith(expect.any(Function), "s", "w");
    expect(seedOkrCycleAndObjectives).toHaveBeenCalledWith(expect.any(Function), "s", "w");
    expect(seedFullDemoData).not.toHaveBeenCalled();
  });

  it("seeds the full demo fixture", async () => {
    const { tx } = fixture();
    await applyPreviewScenario(tx as never, { schema: "s", workspaceId: "w", scenario: "full-data" });
    expect(seedFullDemoData).toHaveBeenCalledWith(expect.any(Function), "s", "w");
  });

  it("routes seed SQL through the caller's transaction, never a fresh connection", async () => {
    const { tx } = fixture();
    vi.mocked(seedFullDemoData).mockImplementationOnce(async (exec) => { await exec("SELECT 1", ["a"]); });
    await applyPreviewScenario(tx as never, { schema: "s", workspaceId: "w", scenario: "full-data" });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith("SELECT 1", "a");
  });

  it("rejects a scenario with no seed strategy instead of silently seeding nothing", async () => {
    const { tx } = fixture();
    await expect(
      applyPreviewScenario(tx as never, { schema: "s", workspaceId: "w", scenario: "unmapped" as PreviewScenario })
    ).rejects.toThrow(/no seed strategy/i);
  });
});

describe("bootstrap fixture seeding", () => {
  it("leaves grants without a scenario on the bare fixture", async () => {
    const { client } = fixture();
    await bootstrapPreviewRun(client, grant, new Date());
    expect(seedSquads).not.toHaveBeenCalled();
    expect(seedFullDemoData).not.toHaveBeenCalled();
  });

  it("seeds only the primary workspace, keeping the isolated one empty", async () => {
    const { tx, client } = fixture();
    await bootstrapPreviewRun(client, { ...grant, scenario: "full-data" }, new Date());
    const run = tx.previewAutomationRun.create.mock.calls[0][0].data;
    expect(seedFullDemoData).toHaveBeenCalledWith(expect.any(Function), expect.any(String), run.workspaceId);
    expect(seedFullDemoData).not.toHaveBeenCalledWith(expect.any(Function), expect.any(String), run.isolatedWorkspaceId);
  });

  it("seeds inside the same transaction as the registry row that owns teardown", async () => {
    const { tx, client } = fixture();
    vi.mocked(seedFullDemoData).mockImplementationOnce(async () => {
      expect(tx.previewAutomationRun.create).toHaveBeenCalled();
    });
    await bootstrapPreviewRun(client, { ...grant, scenario: "full-data" }, new Date());
    expect(seedFullDemoData).toHaveBeenCalled();
  });

  it("does not seed when a duplicate nonce aborts the run", async () => {
    const { tx, client } = fixture();
    tx.previewAutomationNonce.create.mockRejectedValue(new Error("duplicate"));
    await expect(bootstrapPreviewRun(client, { ...grant, scenario: "full-data" })).rejects.toThrow("duplicate");
    expect(seedFullDemoData).not.toHaveBeenCalled();
  });

  it("does not reseed an already-bootstrapped run on retry", async () => {
    const { tx, client } = fixture();
    tx.previewAutomationRun.findUnique.mockResolvedValue({
      id: "run", deploymentId: "deployment", expiresAt: new Date(Date.now() + 60000), revokedAt: null,
    });
    await bootstrapPreviewRun(client, { ...grant, scenario: "full-data" }, new Date());
    expect(seedFullDemoData).not.toHaveBeenCalled();
  });
});
