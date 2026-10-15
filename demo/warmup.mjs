/**
 * Replays the demo's own actions (demo.config.json) headlessly against the dev
 * server so that every route, panel API and server action has been compiled
 * before the recording starts. It writes to the throwaway demo database; the
 * caller re-seeds afterwards. Cue timing is ignored, only the steps matter.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

let activeBrowser = null;

/** Close the headless browser if the server is being stopped mid warm-up. */
export async function closeWarmup() {
  await activeBrowser?.close().catch(() => {});
  activeBrowser = null;
}

export async function warmup(app, log) {
  const { chromium } = await import(pathToFileURL(path.join(here, "engine/node_modules/@playwright/test/index.mjs")).href);
  const config = JSON.parse(fs.readFileSync(path.join(here, "demo.config.json"), "utf8"));
  const browser = await chromium.launch();
  activeBrowser = browser;
  const context = await browser.newContext({ viewport: { width: config.capture.width, height: config.capture.height } });
  try {
    const csrf = await (await context.request.get(`${app}/api/auth/csrf`)).json();
    await context.request.post(`${app}/api/auth/callback/dev-credentials`, {
      form: { csrfToken: csrf.csrfToken, email: "maya@northstar.test", json: "true" },
    });
    const page = await context.newPage();
    await page.goto(`${app}/northstar/ember/feedback`, { waitUntil: "networkidle", timeout: 180_000 });
    let failures = 0;
    for (const scene of config.scenes) {
      for (const action of scene.actions) {
        try {
          if (action.type === "click") {
            const locator = page.locator(action.selector).first();
            await locator.waitFor({ state: "visible", timeout: 20_000 });
            await locator.click({ timeout: 10_000 });
            await page.waitForTimeout(400);
          } else if (action.type === "hover") {
            const locator = page.locator(action.selector).first();
            await locator.waitFor({ state: "visible", timeout: 20_000 });
            await locator.hover({ timeout: 10_000 });
          } else if (action.type === "waitFor") {
            await page.locator(action.selector).first().waitFor({ state: "visible", timeout: 20_000 });
          } else if (action.type === "type") {
            await page.keyboard.type(action.text, { delay: 5 });
          } else if (action.type === "press") {
            await page.keyboard.press(action.key);
            await page.waitForTimeout(300);
          }
        } catch (error) {
          if (!action.optional) {
            failures++;
            log(`warm-up: ${scene.id} ${action.type} ${action.selector ?? action.key ?? ""} failed: ${String(error.message).split("\n")[0]}`);
          }
        }
      }
      await page.waitForTimeout(800);
    }
    log(`warm-up finished (${failures} step failure${failures === 1 ? "" : "s"})`);
  } finally {
    await browser.close();
  }
}
