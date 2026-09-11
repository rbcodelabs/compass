import { NextResponse } from "next/server";
import getPrisma from "@/lib/db";
import { PREVIEW_SESSION_COOKIE, PREVIEW_SESSION_OPTIONS } from "@/lib/preview-automation/cookies";
import {
  isPreviewLoginEnabled,
  isPreviewLoginPersona,
  issuePreviewLoginSession,
  verifyPreviewLoginAccessCode,
} from "@/lib/preview-login";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 4096;

function reply(body: object, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

/** Bounded reader — mirrors lib/preview-automation/handler.ts's readBody. */
async function readBoundedBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_BODY_BYTES) { await reader.cancel(); throw new Error("Body too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Accepts a plain HTML `<form method="POST">` (application/x-www-form-urlencoded,
 * the default and only encoding the /preview-login page emits, no JS
 * required) or a JSON body. Anything else is parsed as form data.
 */
async function parseFields(request: Request): Promise<{ code: unknown; persona: unknown }> {
  const contentType = request.headers.get("content-type") ?? "";
  const raw = await readBoundedBody(request);
  if (contentType.includes("application/json")) {
    const body: unknown = raw ? JSON.parse(raw) : {};
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid body");
    const record = body as Record<string, unknown>;
    return { code: record.code, persona: record.persona };
  }
  const params = new URLSearchParams(raw);
  return { code: params.get("code"), persona: params.get("persona") };
}

export async function POST(request: Request): Promise<Response> {
  // Deliberately precedes body parsing and all database work — same
  // fail-closed-before-DB-access shape as handlePreviewAutomation.
  if (!isPreviewLoginEnabled()) return reply({ error: "Not found" }, 404);

  let code: unknown;
  let persona: unknown;
  try {
    ({ code, persona } = await parseFields(request));
  } catch {
    return reply({ error: "Invalid request" }, 400);
  }

  if (!isPreviewLoginPersona(persona)) return reply({ error: "Invalid request" }, 400);
  // Same generic message whether the code is missing or wrong — never
  // reveal which check failed.
  if (!verifyPreviewLoginAccessCode(code)) return reply({ error: "Unauthorized" }, 401);

  try {
    const prisma = getPrisma();
    const session = await issuePreviewLoginSession(prisma, persona);
    const response = NextResponse.redirect(new URL(`/${session.orgSlug}/${session.workspaceSlug}`, request.url), 303);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.cookies.set(PREVIEW_SESSION_COOKIE, session.sessionToken, { ...PREVIEW_SESSION_OPTIONS, expires: session.expiresAt });
    return response;
  } catch {
    // Never emit tokens, cookie values, stack traces, or DB details.
    return reply({ error: "Preview login failed; try again" }, 500);
  }
}
