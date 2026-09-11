import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyPreviewGrant } from "@/lib/preview-automation/grants";
import { signGrant } from "../../scripts/preview-automation/contracts";

const keys = generateKeyPairSync("ed25519");
const context = {
  deploymentId: "dpl_revision1", origin: "https://compass-revision1-team.vercel.app",
  publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
};
const runId = "39f0a355-278a-4ef4-8eab-72591ec6cce1";
const claims = {
  v: 1, iss: "compass-preview-controller", aud: "compass-preview-automation",
  deploymentId: context.deploymentId, origin: context.origin, runId,
  nonce: "39f0a355-278a-4ef4-8eab-72591ec6cce2", operation: "bootstrap", iat: 1000, exp: 1300,
};
function signed(payload: unknown) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(null, Buffer.from(encoded), keys.privateKey).toString("base64url")}`;
}

describe("independent QA: signed grant ambiguity rejection", () => {
  it("interoperates with the controller signer rather than a test-only signer", () => {
    const grant = signGrant({ deploymentId: context.deploymentId, origin: context.origin, runId, operation: "session", persona: "owner" }, keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), 1000);
    expect(verifyPreviewGrant(grant, context, "session", 1001)).toMatchObject({ runId, operation: "session", persona: "owner" });
  });
  it.each([null, [], "bootstrap", 42, true])("rejects signed non-object payload %j", payload => {
    expect(() => verifyPreviewGrant(signed(payload), context, "bootstrap", 1001)).toThrow();
  });
  it.each([
    { email: "existing@example.com" }, { userId: "existing-user" }, { role: "ADMIN" },
    { workspaceId: "real-workspace" }, { schema: "compass_prod" }, { persona: "owner" },
    { iat: "1000" }, { exp: "1300" }, { iat: 1000.5 }, { exp: 1300.5 },
    { exp: null }, { exp: 999 }, { iat: -1 }, { nonce: "same-nonce" },
    { runId: `${runId}\n` }, { operation: "bootstrap\n" },
    { runId: [runId] }, { nonce: [claims.nonce] },
  ])("rejects signed ambiguous or authority-expanding claims %j", overrides => {
    expect(() => verifyPreviewGrant(signed({ ...claims, ...overrides }), context, "bootstrap", 1001)).toThrow();
  });
  it("rejects a grant exactly at its expiry boundary", () => {
    expect(() => verifyPreviewGrant(signed(claims), context, "bootstrap", 1300)).toThrow();
  });
  it("rejects a correctly signed payload carrying an arbitrary session persona", () => {
    expect(() => verifyPreviewGrant(signed({ ...claims, operation: "session", persona: "admin" }), context, "session", 1001)).toThrow();
  });
  it("rejects a signature from an unrelated issuer key", () => {
    const unrelated = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => verifyPreviewGrant(signed(claims), { ...context, publicKey: unrelated }, "bootstrap", 1001)).toThrow();
  });
  it("rejects appended token components", () => {
    expect(() => verifyPreviewGrant(`${signed(claims)}.extra`, context, "bootstrap", 1001)).toThrow();
  });
  it("rejects oversized input without accepting a valid signed prefix", () => {
    expect(() => verifyPreviewGrant(`${signed(claims)}${"A".repeat(100_000)}`, context, "bootstrap", 1001)).toThrow();
  });
});
