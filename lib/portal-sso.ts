/**
 * Portal SSO Identify — verifying customer-signed JWTs.
 *
 * A Compass customer's own backend mints a short-lived HS256 JWT (using the
 * per-workspace shared secret generated in workspace settings) asserting
 * one of THEIR logged-in users' identity, and links to
 * /api/portal/[orgSlug]/[workspaceSlug]/sso?token=<jwt>. That route (not
 * this file) exchanges a valid token for a real PortalAccount/PortalSession
 * — see lib/portal-auth.ts. This file only knows how to generate secrets
 * and verify tokens; it has no DB or cookie access.
 */
import { randomBytes } from "crypto";
import { jwtVerify } from "jose";

const SECRET_LENGTH_BYTES = 32;
const MAX_TOKEN_AGE = "5 minutes";

export interface SsoIdentity {
  email: string;
  name?: string;
}

/** Generates a new random shared secret for a workspace to hand to a customer's backend. */
export function generateSsoSecret(): string {
  return randomBytes(SECRET_LENGTH_BYTES).toString("base64");
}

/**
 * Verifies an inbound SSO Identify token against a workspace's shared
 * secret. Fails closed on any problem — bad signature, wrong algorithm,
 * expired token, token older than 5 minutes, or a missing/malformed
 * `email` claim all return null rather than throwing, so callers never
 * need a try/catch to stay safe.
 */
export async function verifySsoToken(secret: string, token: string): Promise<SsoIdentity | null> {
  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      maxTokenAge: MAX_TOKEN_AGE,
      requiredClaims: ["email", "iat", "exp"],
    });

    const emailClaim = payload.email;
    if (typeof emailClaim !== "string") return null;
    const email = emailClaim.trim().toLowerCase();
    if (!email) return null;

    const nameClaim = payload.name;
    if (nameClaim !== undefined && typeof nameClaim !== "string") return null;
    const name = typeof nameClaim === "string" && nameClaim.trim() ? nameClaim.trim() : undefined;

    return name !== undefined ? { email, name } : { email };
  } catch {
    return null;
  }
}
