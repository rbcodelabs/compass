import { test as base, expect, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { originHeaders } from "../../scripts/preview-automation/contracts";

export type PreviewFixture = {
  orgSlug: string; workspaceSlug: string; isolatedWorkspaceSlug: string; runId: string; expiresAt: string;
  workspaceId: string; isolatedWorkspaceId: string; apiKey: string; oauthReadToken: string;
};
export function fixture(): PreviewFixture {
  if (!process.env.PREVIEW_FIXTURE) throw new Error("Preview fixture metadata is required");
  return JSON.parse(process.env.PREVIEW_FIXTURE) as PreviewFixture;
}
export function previewRequestOptions(origin: string, bypass: string) {
  return { baseURL: origin, extraHTTPHeaders: originHeaders(origin, origin, bypass) };
}
export function previewRequestCallOptions<T extends Record<string, unknown>>(options?: T) {
  return { ...(options ?? {}), maxRedirects: 0 };
}
const requestMethods = new Set(["delete", "fetch", "get", "head", "patch", "post", "put"]);
function confineApiRequestContext(request: APIRequestContext): APIRequestContext {
  return new Proxy(request, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") return value;
      if (requestMethods.has(String(property))) {
        return (url: string, options?: Record<string, unknown>) => value.call(target, url, previewRequestCallOptions(options));
      }
      return value.bind(target);
    },
  });
}
export async function confinePreviewRequests(context: BrowserContext) {
  const origin = process.env.PREVIEW_ORIGIN;
  if (!origin) throw new Error("Validated preview origin is required");
  await context.route("**/*", async route => {
    const request = route.request();
    if (new URL(request.url()).origin !== origin) return route.abort();
    // Browser follows each redirect afresh through this handler; fetch itself
    // must not forward the bypass header to a redirect destination.
    const response = await route.fetch({
      headers: { ...request.headers(), ...originHeaders(origin, request.url(), process.env.PREVIEW_PROTECTION_BYPASS ?? "") },
      maxRedirects: 0,
    });
    await route.fulfill({ response });
  });
}
export const test = base.extend({
  context: async ({ context }, use) => {
    await confinePreviewRequests(context);
    await use(context);
  },
  request: async ({ playwright }, use) => {
    const origin = process.env.PREVIEW_ORIGIN;
    if (!origin) throw new Error("Validated preview origin is required");
    const request = await playwright.request.newContext(previewRequestOptions(origin, process.env.PREVIEW_PROTECTION_BYPASS ?? ""));
    try { await use(confineApiRequestContext(request)); }
    finally { await request.dispose(); }
  },
});
export { expect };
