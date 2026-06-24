import { test } from "@playwright/test";
import path from "path";
import fs from "fs";

const OUT = path.join(process.cwd(), "public/screenshots/docs");
fs.mkdirSync(OUT, { recursive: true });

// Pages to capture — each with a filename and URL path
const PAGES = [
  { file: "login.png",           url: "/login" },
  { file: "dashboard.png",       url: "/dashboard" },
  { file: "okrs.png",            url: "/rb-code-labs/helios/okrs" },
  { file: "discovery-board.png", url: "/rb-code-labs/helios/discovery" },
  { file: "roadmap.png",         url: "/rb-code-labs/helios/roadmap" },
  { file: "experiments.png",     url: "/rb-code-labs/helios/experiments" },
  { file: "feedback.png",        url: "/rb-code-labs/helios/feedback" },
  { file: "docs-editor.png",     url: "/rb-code-labs/helios/docs" },
  { file: "settings.png",        url: "/rb-code-labs/helios/settings" },
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
