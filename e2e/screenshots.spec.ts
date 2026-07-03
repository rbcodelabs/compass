import { test } from "@playwright/test";
import path from "path";
import fs from "fs";

const OUT = path.join(process.cwd(), "public/screenshots/docs");
fs.mkdirSync(OUT, { recursive: true });

// Pages to capture — each with a filename and URL path.
//
// The demo org/workspace was renamed rb-code-labs/helios → rbcodelabs/compass
// in production (see setup-compass-workspace.ts) a while back; these paths
// had gone stale and pointed at a slug pair that no longer exists anywhere.
// rbcodelabs/compass is the equivalent seeded locally by
// seed-screenshots.ts (run that first, and pass DOCS_SESSION_FILE for a
// session authenticated as rick@rbcodelabs.com, to populate real content
// before running this against a local dev server).
const PAGES = [
  { file: "login.png",           url: "/login" },
  { file: "dashboard.png",       url: "/dashboard" },
  { file: "okrs.png",            url: "/rbcodelabs/compass/okrs" },
  { file: "discovery-board.png", url: "/rbcodelabs/compass/discovery" },
  { file: "roadmap.png",         url: "/rbcodelabs/compass/roadmap" },
  { file: "experiments.png",     url: "/rbcodelabs/compass/experiments" },
  { file: "feedback.png",        url: "/rbcodelabs/compass/feedback" },
  { file: "docs-editor.png",     url: "/rbcodelabs/compass/docs" },
  { file: "settings.png",        url: "/rbcodelabs/compass/settings" },
];

test.describe("docs screenshots", () => {
  test.use({
    storageState: process.env.DOCS_SESSION_FILE
      ? process.env.DOCS_SESSION_FILE
      : undefined,
  });

  for (const { file, url } of PAGES) {
    test(`capture ${file}`, async ({ page }) => {
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      // Give dynamic content a moment to settle
      await page.waitForTimeout(800);
      await page.screenshot({
        path: path.join(OUT, file),
        fullPage: false,
        animations: "disabled",
      });
      console.log(`Saved ${file}`);
    });
  }
});
