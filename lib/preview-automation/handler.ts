import { NextResponse } from "next/server";
import getPrisma from "@/lib/db";
import { getActiveSchema } from "@/lib/schema";
import { verifyPreviewGrant, type PreviewOperation, type PreviewGrant } from "./grants";
import { bootstrapPreviewRun, issuePreviewSession, teardownPreviewRun, PREVIEW_SESSION_COOKIE, PREVIEW_SESSION_OPTIONS } from "./service";

function reply(body: object, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
async function readBody(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 1024) { await reader.cancel(); throw new Error("Body too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid body");
  return body as Record<string, unknown>;
}

export async function handlePreviewAutomation(request: Request, operation: PreviewOperation): Promise<Response> {
  // Deliberately precedes metadata validation, auth parsing, and all database work.
  if (process.env.VERCEL_ENV !== "preview" || process.env.PREVIEW_AUTOMATION_ENABLED !== "1") return reply({ error: "Not found" }, 404);
  let grant: PreviewGrant;
  try {
    getActiveSchema();
    const deploymentId = process.env.VERCEL_DEPLOYMENT_ID;
    const hostname = process.env.VERCEL_URL;
    const publicKey = process.env.PREVIEW_AUTOMATION_PUBLIC_KEY;
    if (!deploymentId || !hostname || !/^[a-z0-9-]+\.vercel\.app$/.test(hostname) || !publicKey) return reply({ error: "Preview automation unavailable" }, 503);
    const origin = `https://${hostname}`;
    if (new URL(request.url).origin !== origin) return reply({ error: "Invalid deployment" }, 401);
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) return reply({ error: "Unauthorized" }, 401);
    grant = verifyPreviewGrant(authorization.slice(7), { deploymentId, origin, publicKey }, operation);
    const body = await readBody(request);
    // The body must echo exactly the grant's own optional claims and nothing
    // else, so a signed grant can never be replayed against a different
    // persona or fixture than the one it authorizes.
    const expected: Record<string, unknown> = operation === "session" ? { persona: grant.persona }
      : operation === "bootstrap" && grant.scenario !== undefined ? { scenario: grant.scenario }
      : {};
    const expectedKeys = Object.keys(expected);
    if (Object.keys(body).length !== expectedKeys.length || expectedKeys.some((key) => body[key] !== expected[key])) return reply({ error: "Invalid request" }, 400);
  } catch { return reply({ error: "Invalid preview request" }, 401); }
  try {
    const prisma = getPrisma();
    if (operation === "bootstrap") return reply(await bootstrapPreviewRun(prisma, grant));
    if (operation === "teardown") return reply(await teardownPreviewRun(prisma, grant));
    const session = await issuePreviewSession(prisma, grant);
    const response = reply({ expiresAt: session.expiresAt.toISOString() });
    response.cookies.set(PREVIEW_SESSION_COOKIE, session.sessionToken, { ...PREVIEW_SESSION_OPTIONS, expires: session.expiresAt });
    return response;
  } catch {
    // Never emit grant material, tokens, SQL, or configuration in the public response.
    return reply({ error: "Preview operation failed; retry with a fresh grant" }, 409);
  }
}
