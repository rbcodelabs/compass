import { test as base, expect, type BrowserContext } from "@playwright/test";
import { originHeaders } from "../../scripts/preview-automation/contracts";

export type PreviewFixture = { orgSlug: string; workspaceSlug: string; isolatedWorkspaceSlug: string; runId: string; expiresAt: string };
export function fixture(): PreviewFixture {
  if (!process.env.PREVIEW_FIXTURE) throw new Error("Preview fixture metadata is required");
  return JSON.parse(process.env.PREVIEW_FIXTURE) as PreviewFixture;
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
});
export { expect };
