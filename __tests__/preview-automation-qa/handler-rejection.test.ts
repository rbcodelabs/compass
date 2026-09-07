import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const initialize = vi.hoisted(() => vi.fn(() => { throw new Error("database initialization must not occur"); }));
vi.mock("@/lib/db", () => ({ default: initialize }));
import { handlePreviewAutomation } from "@/lib/preview-automation/handler";
import { signGrant, type GrantInput } from "../../scripts/preview-automation/contracts";

const keys = generateKeyPairSync("ed25519");
const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const origin = "https://compass-revision1-team.vercel.app";
const binding = { deploymentId: "dpl_revision1", origin, runId: "39f0a355-278a-4ef4-8eab-72591ec6cce1" };
function request(operation: GrantInput["operation"] = "bootstrap", body: unknown = {}, overrides: Partial<GrantInput> = {}, requestOrigin = origin) {
  return new Request(`${requestOrigin}/api/preview-automation/${operation}`, {
    method: "POST", headers: { authorization: `Bearer ${signGrant({ ...binding, operation, ...overrides }, privateKey)}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
beforeEach(() => {
  initialize.mockClear();
  vi.stubEnv("VERCEL_ENV", "preview"); vi.stubEnv("PREVIEW_AUTOMATION_ENABLED", "1");
  vi.stubEnv("VERCEL_GIT_PULL_REQUEST_ID", "156"); vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "a".repeat(40));
  vi.stubEnv("VERCEL_DEPLOYMENT_ID", binding.deploymentId); vi.stubEnv("VERCEL_URL", new URL(origin).hostname);
  vi.stubEnv("PREVIEW_AUTOMATION_PUBLIC_KEY", keys.publicKey.export({ type: "spki", format: "pem" }).toString());
});
afterEach(() => vi.unstubAllEnvs());

describe("independent QA: endpoint rejection precedes database initialization", () => {
  it.each(["bootstrap", "session", "teardown"] as const)("hides %s in production even with valid signed authorization", async operation => {
    vi.stubEnv("VERCEL_ENV", "production");
    const response = await handlePreviewAutomation(request(operation), operation);
    expect(response.status).toBe(404);
    expect(initialize).not.toHaveBeenCalled();
  });
  it.each(["", "0", "true"])("requires the exact explicit opt-in value, not %j", async enabled => {
    vi.stubEnv("PREVIEW_AUTOMATION_ENABLED", enabled);
    expect((await handlePreviewAutomation(request(), "bootstrap")).status).toBe(404);
    expect(initialize).not.toHaveBeenCalled();
  });
  it.each([{ email: "real@example.com" }, { userId: "real-user" }, { schema: "compass_prod" }, { role: "ADMIN" }, { runId: "another-run" }])("does not let bootstrap body expand authority: %j", async body => {
    expect((await handlePreviewAutomation(request("bootstrap", body), "bootstrap")).status).toBe(400);
    expect(initialize).not.toHaveBeenCalled();
  });
  it.each([null, [], "hello", "x".repeat(2000)])("rejects malformed or oversized body %j", async body => {
    expect((await handlePreviewAutomation(request("bootstrap", body), "bootstrap")).status).toBe(401);
    expect(initialize).not.toHaveBeenCalled();
  });
  it("rejects disagreement between the signed persona and request body", async () => {
    const response = await handlePreviewAutomation(request("session", { persona: "owner" }, { persona: "viewer" }), "session");
    expect(response.status).toBe(400);
    expect(initialize).not.toHaveBeenCalled();
  });
  it("rejects an origin mismatch despite the valid signing key", async () => {
    const response = await handlePreviewAutomation(request("bootstrap", {}, {}, "https://compass-git-alias-team.vercel.app"), "bootstrap");
    expect(response.status).toBe(401);
    expect(initialize).not.toHaveBeenCalled();
  });
  it("rejects a bootstrap grant presented to the teardown operation", async () => {
    expect((await handlePreviewAutomation(request(), "teardown")).status).toBe(401);
    expect(initialize).not.toHaveBeenCalled();
  });
  it("rejects missing deployment metadata instead of using the shared preview schema", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    expect((await handlePreviewAutomation(request(), "bootstrap")).status).not.toBe(200);
    expect(initialize).not.toHaveBeenCalled();
  });
  it("marks rejection responses uncacheable without echoing signed material", async () => {
    const input = request("bootstrap", { email: "secret-real@example.com" });
    const authorization = input.headers.get("authorization")!;
    const response = await handlePreviewAutomation(input, "bootstrap");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const body = await response.text();
    expect(body).not.toContain(authorization);
    expect(body).not.toContain("secret-real@example.com");
  });
});
