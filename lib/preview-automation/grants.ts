import { createPublicKey, verify } from "node:crypto";

export type PreviewOperation = "bootstrap" | "session" | "teardown";
export type PreviewPersona = "owner" | "viewer";
export interface PreviewGrant {
  v: 1;
  iss: "compass-preview-controller";
  aud: "compass-preview-automation";
  deploymentId: string;
  origin: string;
  runId: string;
  operation: PreviewOperation;
  nonce: string;
  iat: number;
  exp: number;
  persona?: PreviewPersona;
}
export interface PreviewContext {
  deploymentId: string;
  origin: string;
  publicKey: string;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fields = new Set(["v", "iss", "aud", "deploymentId", "origin", "runId", "operation", "nonce", "iat", "exp", "persona"]);

/** Verify before parsing or touching the DB. Nonce consumption belongs to the mutation transaction. */
export function verifyPreviewGrant(token: string, context: PreviewContext, operation: PreviewOperation, now = Math.floor(Date.now() / 1000)): PreviewGrant {
  const fail = () => { throw new Error("Invalid preview automation grant"); };
  if (token.length > 4096) return fail();
  const parts = token.split(".");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return fail();
  const key = createPublicKey(context.publicKey);
  if (key.asymmetricKeyType !== "ed25519" || !verify(null, Buffer.from(parts[0]), key, Buffer.from(parts[1], "base64url"))) return fail();
  const claims = JSON.parse(Buffer.from(parts[0], "base64url").toString()) as PreviewGrant;
  if (!claims || typeof claims !== "object" || Object.keys(claims).some((key) => !fields.has(key))) return fail();
  if (claims.v !== 1 || claims.iss !== "compass-preview-controller" || claims.aud !== "compass-preview-automation" ||
    claims.deploymentId !== context.deploymentId || claims.origin !== context.origin || claims.operation !== operation ||
    typeof claims.runId !== "string" || !uuid.test(claims.runId) || typeof claims.nonce !== "string" || !uuid.test(claims.nonce) ||
    !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.iat > now ||
    claims.exp <= now || claims.exp <= claims.iat || claims.exp - claims.iat > 300 ||
    (operation === "session" ? !["owner", "viewer"].includes(claims.persona ?? "") : claims.persona !== undefined)) return fail();
  return claims;
}
