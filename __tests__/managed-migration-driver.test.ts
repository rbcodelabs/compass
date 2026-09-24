import { describe, expect, it, vi } from "vitest";
import { runManagedMigration } from "../scripts/preview-automation/managed-driver";
const target = { deploymentId: "dpl_Test", origin: "https://immutable.vercel.app", sha: "a".repeat(40), schema: "compass_pr_276_aaaaaaaaaaaa", pr: 276 };
describe("manual managed migration driver", () => {
  it("refuses another PR before sending migration credentials", async () => {
    const fetcher = vi.fn();
    await expect(runManagedMigration({ ...target, pr: 277 }, "status", "secret", "bypass", fetcher)).rejects.toThrow(/276/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not post an absent/nonpending script", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ schema: target.schema, pending: [], managed: { owner: { claimed_by: null } } }));
    await expect(runManagedMigration(target, "059_geode_document_storage", "secret", "bypass", fetcher)).rejects.toThrow(/pending/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("performs a status GET before a named POST and after a202", async () => {
    const status = { schema: target.schema, pending: ["039_native_decision_gates"], managed: { owner: { claimed_by: null } } };
    const fetcher = vi.fn().mockImplementation(async (_url, init) => Response.json(init.method === "POST" ? { migrationProgress: { state: "WAITING" } } : status, { status: init.method === "POST" ? 202 : 200 }));
    const result = await runManagedMigration(target, "039_native_decision_gates", "secret", "bypass", fetcher);
    expect(fetcher.mock.calls.map(c => c[1].method)).toEqual(["GET", "POST", "GET"]);
    expect(result.httpStatus).toBe(202);
    expect(fetcher.mock.calls[1][1].headers["x-preview-deployment-id"]).toBe("dpl_Test");
  });
  it("never retries an uncertain POST", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ schema: target.schema, pending: ["001_init"], managed: { owner: { claimed_by: null } } })).mockRejectedValueOnce(new Error("timeout"));
    await expect(runManagedMigration(target, "001_init", "secret", "bypass", fetcher)).rejects.toThrow(/inspect/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
