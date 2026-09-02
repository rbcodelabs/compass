import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePreviewFixtureOrchestrationArgs } from "@/scripts/run-preview-performance-fixture";

const common = [
  "--run-id", `perf_preview_${"a".repeat(32)}`,
  "--deployment-sha", "b".repeat(40),
  "--deployment-id", `dpl_${"C".repeat(24)}`,
  "--deployment-url", "https://compass-abc123-rbcodelabs-team.vercel.app/",
];

describe("preview fixture HTTPS orchestration", () => {
  it("accepts only seed, cleanup, and verify with bounded expiry", () => {
    expect(parsePreviewFixtureOrchestrationArgs(["seed", ...common, "--expires-minutes", "20"])).toMatchObject({ command: "seed", expiresMinutes: 20 });
    expect(parsePreviewFixtureOrchestrationArgs(["cleanup", ...common])).toMatchObject({ command: "cleanup" });
    expect(parsePreviewFixtureOrchestrationArgs(["verify", ...common])).toMatchObject({ command: "verify" });
    expect(() => parsePreviewFixtureOrchestrationArgs(["seed", ...common, "--expires-minutes", "31"])).toThrow(/15 through 30/);
    expect(() => parsePreviewFixtureOrchestrationArgs(["seed", ...common, "--session-token", "secret"])).toThrow(/Unknown/);
  });

  it("contains no direct AWS, OIDC, Prisma, or DSQL connector path", () => {
    const source = fs.readFileSync("scripts/run-preview-performance-fixture.ts", "utf8");
    for (const forbidden of ["@aws-sdk", "awsCredentialsProvider", "PrismaClient", "DsqlSigner", "PGHOST"]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
