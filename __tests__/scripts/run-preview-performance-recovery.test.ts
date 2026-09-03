import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseRecoveryArgs } from "@/scripts/run-preview-performance-recovery";

describe("preview recovery CLI", () => {
  it("accepts only cleanup and verify with exact executor identity", () => {
    const args = ["cleanup", "--deployment-sha", "a".repeat(40), "--deployment-id", `dpl_${"A".repeat(24)}`, "--deployment-url", "https://compass-recovery-rbcodelabs-team.vercel.app/"];
    expect(parseRecoveryArgs(args)).toMatchObject({ action: "cleanup" });
    expect(() => parseRecoveryArgs(["seed", ...args.slice(1)])).toThrow(/Usage/);
  });

  it.each(["performance:preview-recovery-cleanup", "performance:preview-recovery-verify"])("executes %s instead of silently no-oping", (script) => {
    const result = spawnSync("pnpm", [script], { encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("Missing --deployment-sha");
  });
});
