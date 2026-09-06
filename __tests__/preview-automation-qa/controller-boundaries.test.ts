import { describe, expect, it } from "vitest";
import { originHeaders, schemaFor, validateDeployment } from "../../scripts/preview-automation/contracts";

const sha = "a".repeat(40);
const deployment = {
  id: "dpl_revision1", url: "compass-revision1-team.vercel.app", projectId: "prj_compass",
  readyState: "READY", target: null,
  meta: { githubCommitSha: sha, githubCommitOrg: "rbcodelabs", githubCommitRepo: "compass", githubPrId: "156" },
};
const pr = {
  number: 156, state: "open", head: { sha, repo: { full_name: "rbcodelabs/compass" } },
  base: { repo: { full_name: "rbcodelabs/compass" } },
};

describe("independent QA: deployment identity boundaries", () => {
  it.each(["BUILDING", "QUEUED", "ERROR", "CANCELED", ""])('rejects deployment readiness "%s"', readyState => {
    expect(() => validateDeployment({ ...deployment, readyState }, pr, "prj_compass")).toThrow();
  });
  it.each([
    "compass-git-feature-team.vercel.app", "compass.vercel.app.evil.example", "compass.vercel.app:443",
    "compass.vercel.app/path", "compass.vercel.app?foo=bar", "user@compass.vercel.app",
    "COMPASS.vercel.app", "compass.vercel.app\n", "localhost",
  ])("rejects noncanonical or branch-alias deployment host %s", url => {
    expect(() => validateDeployment({ ...deployment, url }, pr, "prj_compass")).toThrow();
  });
  it("rejects deleted fork identity even when the commit SHA matches", () => {
    expect(() => validateDeployment(deployment, { ...pr, head: { sha, repo: null } }, "prj_compass")).toThrow();
  });
  it("rejects a deployment whose PR number differs even at the same commit", () => {
    expect(() => validateDeployment({ ...deployment, meta: { ...deployment.meta, githubPrId: "157" } }, pr, "prj_compass")).toThrow();
  });
  it("rejects absent trusted project configuration", () => {
    expect(() => validateDeployment({ ...deployment, projectId: "" }, pr, "")).toThrow();
  });
  it("rejects a same-named repository in another base organization", () => {
    expect(() => validateDeployment(deployment, { ...pr, base: { repo: { full_name: "attacker/compass" } } }, "prj_compass")).toThrow();
  });
  it("assigns distinct namespaces to separate commits of the same PR", () => {
    expect(schemaFor(156, sha)).not.toBe(schemaFor(156, "b".repeat(40)));
  });
  it.each(["0", "-1", "0156", "1e2", "1.5", "156\n", "156;select 1", "99999999999"])('rejects noncanonical PR identifier "%s"', number => {
    expect(() => schemaFor(number, sha)).toThrow();
  });
});

describe("independent QA: protection header origin confinement", () => {
  it.each([
    "http://safe.vercel.app/", "https://safe.vercel.app:444/", "https://safe.vercel.app.evil.example/",
    "https://safe.vercel.app@evil.example/", "https://other.vercel.app/", "data:text/plain,hello",
  ])("does not disclose bypass material to %s", destination => {
    expect(originHeaders("https://safe.vercel.app", destination, "never-leak-this")).toEqual({});
  });
  it("does not manufacture a header without configured bypass material", () => {
    expect(originHeaders("https://safe.vercel.app", "https://safe.vercel.app/", "")).toEqual({});
  });
});
