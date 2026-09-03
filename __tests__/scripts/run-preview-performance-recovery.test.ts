import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseRecoveryArgs, validateRecoveryDeploymentMetadata } from "@/scripts/run-preview-performance-recovery";

describe("preview recovery CLI", () => {
  it("accepts only cleanup, verify, and diagnose with exact executor identity", () => {
    const args = ["cleanup", "--deployment-sha", "a".repeat(40), "--deployment-id", `dpl_${"A".repeat(24)}`, "--deployment-url", "https://compass-recovery-rbcodelabs-team.vercel.app/", "--deployment-metadata-file", "/tmp/recovery-metadata.json"];
    expect(parseRecoveryArgs(args)).toMatchObject({ action: "cleanup" });
    expect(parseRecoveryArgs(["diagnose", ...args.slice(1)])).toMatchObject({ action: "diagnose" });
    expect(() => parseRecoveryArgs(["seed", ...args.slice(1)])).toThrow(/Usage/);
  });

  it("proves dpl to URL, SHA, project, READY, and unaliased metadata", () => {
    const expected = { expectedSha: "a".repeat(40), expectedDeploymentId: `dpl_${"A".repeat(24)}`, deploymentUrl: "https://compass-recovery-rbcodelabs-team.vercel.app/" };
    const metadata = { id: expected.expectedDeploymentId, url: expected.deploymentUrl, sha: expected.expectedSha, projectId: "prj_BofzJ65kFnTykvTkoti7o4hjvxw9", readyState: "READY", aliases: [] };
    expect(() => validateRecoveryDeploymentMetadata(metadata, expected)).not.toThrow();
    for (const changed of [
      { ...metadata, id: `dpl_${"B".repeat(24)}` }, { ...metadata, url: "https://compass-other-rbcodelabs-team.vercel.app/" },
      { ...metadata, sha: "b".repeat(40) }, { ...metadata, projectId: "prj_wrong" }, { ...metadata, readyState: "BUILDING" },
      { ...metadata, aliases: ["compass-preview.example.com"] },
    ]) expect(() => validateRecoveryDeploymentMetadata(changed, expected)).toThrow(/metadata/);
  });

  it.each(["performance:preview-recovery-cleanup", "performance:preview-recovery-verify", "performance:preview-recovery-diagnose"])("executes %s instead of silently no-oping", (script) => {
    const result = spawnSync("pnpm", [script], { encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("Missing --deployment-sha");
  });
});
