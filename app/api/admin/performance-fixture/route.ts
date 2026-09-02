import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getVercelOidcTokenSync } from "@vercel/functions/oidc";
import { getActiveSchema } from "@/lib/schema";
import { previewFixtureIdentityDigest } from "@/lib/preview-performance-fixture";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_BODY_BYTES = 16 * 1024;
const MAX_EXPIRY_MS = 30 * 60_000;
const ALLOWED_KEYS = new Set([
  "action",
  "runId",
  "expectedSha",
  "expectedDeploymentId",
  "expiresAt",
  "sessionToken",
]);

export interface PreviewFixtureRequest {
  action: "preflight" | "seed" | "cleanup" | "verify";
  runId: string;
  expectedSha: string;
  expectedDeploymentId: string;
  expiresAt: string;
  sessionToken?: string;
}

function hidden(status = 404): NextResponse {
  return NextResponse.json(
    { error: status === 404 ? "Not found" : "Request failed" },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function isExactRuntime(req: NextRequest): boolean {
  const env = process.env;
  if (env.VERCEL_ENV !== "preview" || env.COMPASS_PERF_BASELINE !== "1") return false;
  if (env.PERF_SERVER_KIND !== "vercel-preview") return false;
  if (env.DATABASE_URL || env.AWS_PROFILE || env.AWS_ACCESS_KEY_ID || env.AWS_SECRET_ACCESS_KEY || env.AWS_SESSION_TOKEN) return false;
  if (env.PGSCHEMA !== "compass" || getActiveSchema() !== "compass_preview") return false;
  if (!env.PGHOST || !/^[a-z0-9-]+\.dsql\.[a-z0-9-]+\.on\.aws$/.test(env.PGHOST)) return false;
  if (!env.AWS_ROLE_ARN || !env.AWS_REGION) return false;
  if (!env.VERCEL_GIT_COMMIT_SHA || !/^[a-f0-9]{40}$/.test(env.VERCEL_GIT_COMMIT_SHA)) return false;
  if (!env.VERCEL_DEPLOYMENT_ID || !/^dpl_[A-Za-z0-9]{20,64}$/.test(env.VERCEL_DEPLOYMENT_ID)) return false;
  if (!env.VERCEL_URL || !/^compass-[a-z0-9]+-rbcodelabs-team\.vercel\.app$/.test(env.VERCEL_URL)) return false;
  return req.nextUrl.protocol === "https:" && req.nextUrl.host === env.VERCEL_URL;
}

function hasSecret(req: NextRequest): boolean {
  const expected = process.env.MIGRATION_SECRET;
  const supplied = req.headers.get("x-migration-secret");
  if (!expected || expected.length < 24 || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && crypto.timingSafeEqual(expectedBytes, suppliedBytes);
}

async function readLimitedBody(req: NextRequest): Promise<string | null> {
  const contentLength = req.headers.get("content-length");
  if (!contentLength || !/^\d+$/.test(contentLength)) return null;
  const declared = Number(contentLength);
  if (declared < 2 || declared > MAX_BODY_BYTES || !req.body) return null;
  const reader = req.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES || bytes > declared) return null;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    return null;
  }
  return bytes === declared ? text : null;
}

function parseStrictBody(text: string): PreviewFixtureRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !ALLOWED_KEYS.has(key))) return null;
  const serializedKeys = text.match(/"(?:\\.|[^"\\])*"\s*:/g) ?? [];
  const decodedKeys: string[] = [];
  try {
    for (const serializedKey of serializedKeys) decodedKeys.push(JSON.parse(serializedKey.slice(0, serializedKey.lastIndexOf(":"))));
  } catch {
    return null;
  }
  if (decodedKeys.length !== keys.length || new Set(decodedKeys).size !== decodedKeys.length) return null;
  if (record.action !== "preflight" && record.action !== "seed" && record.action !== "cleanup" && record.action !== "verify") return null;
  if (typeof record.runId !== "string" || !/^perf_preview_[a-f0-9]{32}$/.test(record.runId)) return null;
  if (typeof record.expectedSha !== "string" || !/^[a-f0-9]{40}$/.test(record.expectedSha)) return null;
  if (typeof record.expectedDeploymentId !== "string" || !/^dpl_[A-Za-z0-9]{20,64}$/.test(record.expectedDeploymentId)) return null;
  if (typeof record.expiresAt !== "string") return null;
  const expiresAtMs = Date.parse(record.expiresAt);
  const remainingMs = expiresAtMs - Date.now();
  if (!Number.isFinite(expiresAtMs) || new Date(expiresAtMs).toISOString() !== record.expiresAt || remainingMs <= 0 || remainingMs > MAX_EXPIRY_MS) return null;
  if (record.action === "seed") {
    if (typeof record.sessionToken !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(record.sessionToken)) return null;
  } else if ("sessionToken" in record) return null;
  return record as unknown as PreviewFixtureRequest;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Environment and authorization gates intentionally precede body/token parsing
  // and any import capable of creating a DSQL connector.
  if (!isExactRuntime(req) || !hasSecret(req)) return hidden();
  try {
    if (!getVercelOidcTokenSync()) return hidden();
  } catch {
    return hidden();
  }
  const text = await readLimitedBody(req);
  if (text === null) return hidden();
  const body = parseStrictBody(text);
  if (!body) return hidden();
  if (body.expectedSha !== process.env.VERCEL_GIT_COMMIT_SHA || body.expectedDeploymentId !== process.env.VERCEL_DEPLOYMENT_ID) return hidden();

  if (body.action === "preflight") {
    return NextResponse.json({
      state: "ready",
      checks: { preview: true, schema: true, sha: true, deployment: true, host: true, oidc: true, secret: true },
      identityDigest: previewFixtureIdentityDigest({
        runId: body.runId,
        deploymentSha: process.env.VERCEL_GIT_COMMIT_SHA,
        deploymentId: process.env.VERCEL_DEPLOYMENT_ID,
        deploymentUrl: process.env.VERCEL_URL!,
      }),
    }, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const { executePreviewFixtureAction } = await import("@/lib/preview-performance-fixture-runtime");
    const result = await executePreviewFixtureAction(body);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return hidden(500);
  }
}
