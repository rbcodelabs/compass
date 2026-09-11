import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyPreviewGrant } from "@/lib/preview-automation/grants";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const context = { deploymentId: "dpl_test", origin: "https://test.vercel.app", publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() };
const claims = { v: 1, iss: "compass-preview-controller", aud: "compass-preview-automation", deploymentId: context.deploymentId, origin: context.origin, runId: "2c147952-c92a-4198-a518-5f9fa0e1a2d7", nonce: "2c147952-c92a-4198-a518-5f9fa0e1a2d8", operation: "bootstrap", iat: 1000, exp: 1300 };
function token(overrides = {}) {
  const payload = Buffer.from(JSON.stringify({ ...claims, ...overrides })).toString("base64url");
  return `${payload}.${sign(null, Buffer.from(payload), privateKey).toString("base64url")}`;
}
describe("preview operation grants", () => {
  it("accepts a verified bounded deployment-specific grant", () => {
    expect(verifyPreviewGrant(token(), context, "bootstrap", 1001)).toMatchObject(claims);
  });
  it.each([
    { exp: 1000 }, { exp: 1400 }, { iat: 1100 }, { deploymentId: "dpl_other" },
    { origin: "https://other.vercel.app" }, { operation: "session" }, { runId: "arbitrary" },
    { aud: "other" }, { v: 2 }, { userId: "real-user" },
  ])("rejects invalid or unbound claims %j", (overrides) => {
    expect(() => verifyPreviewGrant(token(overrides), context, "bootstrap", 1001)).toThrow();
  });
  it("rejects tampering", () => {
    expect(() => verifyPreviewGrant(`${token()}a`, context, "bootstrap", 1001)).toThrow();
  });
  it("binds session grants to the synthetic persona", () => {
    expect(verifyPreviewGrant(token({ operation: "session", persona: "viewer" }), context, "session", 1001).persona).toBe("viewer");
    expect(() => verifyPreviewGrant(token({ operation: "session" }), context, "session", 1001)).toThrow();
  });
  it("binds bootstrap grants to a known fixture scenario", () => {
    expect(verifyPreviewGrant(token({ scenario: "full-data" }), context, "bootstrap", 1001).scenario).toBe("full-data");
    expect(verifyPreviewGrant(token({ scenario: "mid-okr-cycle" }), context, "bootstrap", 1001).scenario).toBe("mid-okr-cycle");
  });
  it("treats an absent scenario as the default fixture so existing grants keep working", () => {
    expect(verifyPreviewGrant(token(), context, "bootstrap", 1001).scenario).toBeUndefined();
  });
  it.each([
    { scenario: "arbitrary" }, { scenario: "" }, { scenario: 1 }, { scenario: null }, { scenario: ["full-data"] },
  ])("rejects an unknown bootstrap scenario %j", (overrides) => {
    expect(() => verifyPreviewGrant(token(overrides), context, "bootstrap", 1001)).toThrow();
  });
  it("rejects a scenario on operations that do not seed fixtures", () => {
    expect(() => verifyPreviewGrant(token({ operation: "session", persona: "owner", scenario: "full-data" }), context, "session", 1001)).toThrow();
    expect(() => verifyPreviewGrant(token({ operation: "teardown", scenario: "full-data" }), context, "teardown", 1001)).toThrow();
  });
});
