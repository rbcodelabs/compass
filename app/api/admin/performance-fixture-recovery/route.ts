import crypto from "node:crypto";
import { getVercelOidcTokenSync } from "@vercel/functions/oidc";
import { NextRequest, NextResponse } from "next/server";
import { getActiveSchema } from "@/lib/schema";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_BODY_BYTES = 1024;
const MAX_EXPIRY_MS = 30 * 60_000;
const ALLOWED_KEYS = new Set(["action", "expectedSha", "expectedDeploymentId", "expiresAt"]);

interface RecoveryRequest {
  action: "cleanup" | "verify" | "diagnose";
  expectedSha: string;
  expectedDeploymentId: string;
  expiresAt: string;
}

function hidden(status = 404): NextResponse {
  return NextResponse.json({ error: status === 404 ? "Not found" : "Request failed" }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function exactExecutor(req: NextRequest, body: RecoveryRequest): boolean {
  const env = process.env;
  return !!env.VERCEL_GIT_COMMIT_SHA && /^[a-f0-9]{40}$/.test(env.VERCEL_GIT_COMMIT_SHA) &&
    !!env.VERCEL_DEPLOYMENT_ID && /^dpl_[A-Za-z0-9]{20,64}$/.test(env.VERCEL_DEPLOYMENT_ID) &&
    !!env.VERCEL_URL && /^compass-[a-z0-9]+-rbcodelabs-team\.vercel\.app$/.test(env.VERCEL_URL) &&
    body.expectedSha === env.VERCEL_GIT_COMMIT_SHA && body.expectedDeploymentId === env.VERCEL_DEPLOYMENT_ID &&
    req.nextUrl.protocol === "https:" && req.nextUrl.host === env.VERCEL_URL;
}

function exactRuntimeConfiguration(): boolean {
  const env = process.env;
  try {
    return env.VERCEL_ENV === "preview" &&
      env.COMPASS_PERF_BASELINE === "1" &&
      env.PERF_SERVER_KIND === "vercel-preview" &&
      !env.DATABASE_URL && !env.AWS_PROFILE && !env.AWS_ACCESS_KEY_ID && !env.AWS_SECRET_ACCESS_KEY && !env.AWS_SESSION_TOKEN &&
      env.PGSCHEMA === "compass" && getActiveSchema() === "compass_preview" &&
      !!env.PGHOST && /^[a-z0-9-]+\.dsql\.[a-z0-9-]+\.on\.aws$/.test(env.PGHOST) &&
      !!env.AWS_ROLE_ARN && !!env.AWS_REGION;
  } catch {
    return false;
  }
}

function hasSecret(req: NextRequest): boolean {
  const expected = process.env.MIGRATION_SECRET;
  const supplied = req.headers.get("x-migration-secret");
  if (!expected || expected.length < 24 || !supplied) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function parseBody(req: NextRequest): Promise<RecoveryRequest | null> {
  const declaredText = req.headers.get("content-length");
  if (!declaredText || !/^\d+$/.test(declaredText)) return null;
  const declared = Number(declaredText);
  if (declared < 2 || declared > MAX_BODY_BYTES || !req.body) return null;
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength !== declared) return null;
  let value: unknown;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 4 || keys.some((key) => !ALLOWED_KEYS.has(key))) return null;
  const serializedKeys = text.match(/"(?:\\.|[^"\\])*"\s*:/g) ?? [];
  if (serializedKeys.length !== keys.length) return null;
  if (record.action !== "cleanup" && record.action !== "verify" && record.action !== "diagnose") return null;
  if (typeof record.expectedSha !== "string" || !/^[a-f0-9]{40}$/.test(record.expectedSha)) return null;
  if (typeof record.expectedDeploymentId !== "string" || !/^dpl_[A-Za-z0-9]{20,64}$/.test(record.expectedDeploymentId)) return null;
  if (typeof record.expiresAt !== "string") return null;
  const expiry = Date.parse(record.expiresAt);
  const remaining = expiry - Date.now();
  if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== record.expiresAt || remaining <= 0 || remaining > MAX_EXPIRY_MS) return null;
  return record as unknown as RecoveryRequest;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Secret validation is deliberately the first gate. Diagnostics remain
  // completely silent until both the secret and immutable caller identity pass.
  if (!hasSecret(req)) return hidden();
  const body = await parseBody(req);
  if (!body || !exactExecutor(req, body)) return hidden();
  if (!exactRuntimeConfiguration()) {
    if (body.action === "diagnose") console.info("PF_DIAG_RUNTIME");
    return hidden();
  }
  try {
    if (!getVercelOidcTokenSync()) {
      if (body.action === "diagnose") console.info("PF_DIAG_OIDC");
      return hidden();
    }
  } catch {
    if (body.action === "diagnose") console.info("PF_DIAG_OIDC");
    return hidden();
  }
  if (body.action === "diagnose") {
    console.info("PF_DIAG_READY");
    return hidden();
  }
  try {
    const { executePreviewFixtureRecovery } = await import("@/lib/preview-performance-fixture-recovery");
    return NextResponse.json(await executePreviewFixtureRecovery(body.action), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return hidden(500);
  }
}
