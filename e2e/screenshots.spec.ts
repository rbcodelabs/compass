import { expect, test } from "@playwright/test";
import path from "path";
import fs from "fs";
import {
  GUIDED_UX_SCREENSHOT_TOKEN,
  buildScreenshotCases,
  type ScreenshotCase,
} from "./screenshot-cases";

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
const FUNCTIONAL = process.env.E2E_FUNCTIONAL === "1";
const WORKSPACE_BASE = FUNCTIONAL ? "/e2e-test-org/e2e-workspace" : "/rbcodelabs/compass";

type StandardScreenshotCase = {
  file: string;
  url: string;
  scrollToHeading?: string;
  prepare?: "expand-first-opportunity";
};

const STANDARD_PAGES: StandardScreenshotCase[] = [
  { file: "login.png",           url: "/login" },
  { file: "dashboard.png",       url: "/dashboard" },
  { file: "okrs.png",            url: `${WORKSPACE_BASE}/okrs` },
  { file: "canvas.png",          url: `${WORKSPACE_BASE}/canvas` },
  { file: "discovery-board.png", url: `${WORKSPACE_BASE}/discovery` },
  {
    file: "discovery-table.png",
    url: `${WORKSPACE_BASE}/discovery?view=table`,
    prepare: "expand-first-opportunity",
  },
  { file: "roadmap.png",         url: `${WORKSPACE_BASE}/roadmap` },
  { file: "roadmap-timeline.png", url: `${WORKSPACE_BASE}/roadmap?view=timeline` },
  { file: "tasks.png",           url: `${WORKSPACE_BASE}/tasks` },
  { file: "tasks-list.png",      url: `${WORKSPACE_BASE}/tasks?view=list` },
  { file: "experiments.png",     url: `${WORKSPACE_BASE}/experiments` },
  { file: "feedback.png",        url: `${WORKSPACE_BASE}/feedback` },
  { file: "docs-editor.png",     url: `${WORKSPACE_BASE}/docs` },
  { file: "settings.png",        url: `${WORKSPACE_BASE}/settings` },
  // Settings is one long scrolling page — Branding sits below Portal, past
  // the initial viewport a plain (fullPage: false) capture would show, so
  // it needs its own entry with an explicit scroll-into-view.
  { file: "branding.png",        url: `${WORKSPACE_BASE}/settings`, scrollToHeading: "Branding" },
  // Danger Zone (DeleteWorkspacePanel) is the last section on the settings
  // page, below Branding — same situation branding.png solves above.
  { file: "danger-zone.png",     url: `${WORKSPACE_BASE}/settings`, scrollToHeading: "Danger Zone" },
  // Preview deployments and local DOCS_BASE_URL targets expose the built-in
  // registry. Production returns 404 unless explicitly enabled, so only add
  // this capture when the caller intentionally supplied an eligible target.
  ...(process.env.DOCS_BASE_URL
    ? [{ file: "ui-registry.png", url: "/ui" }]
    : []),
];

const GUIDED_PAGES = buildScreenshotCases({
  workspaceBase: WORKSPACE_BASE,
  includeGuidedUx: FUNCTIONAL || process.env.DOCS_GUIDED_UX_SCREENSHOTS === "1",
  researchToken: process.env.DOCS_RESEARCH_TOKEN || (FUNCTIONAL ? GUIDED_UX_SCREENSHOT_TOKEN : null),
});

const PAGES: Array<StandardScreenshotCase | ScreenshotCase> = [...STANDARD_PAGES, ...GUIDED_PAGES];

async function prepareScreenshot(
  page: import("@playwright/test").Page,
  entry: StandardScreenshotCase | ScreenshotCase,
) {
  if (!entry.prepare) return;

  if (entry.prepare === "expand-first-opportunity") {
    const disclosure = page
      .getByRole("table", { name: "Discovery opportunities" })
      .locator('button[aria-expanded]')
      .first();
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    return;
  }

  if (entry.prepare === "guided-builder") {
    await page.getByRole("radio", { name: "Guided usability test" }).check();
    await page.getByLabel("Study name").fill("Plan selection usability test");
    await page.getByLabel("What are you trying to learn?").fill("Where people hesitate while choosing a plan for their team");
    await page.getByLabel("Live product URL").fill("https://example.com");
    await page.getByLabel("Target duration").selectOption("20");
    const tasks = [
      "Find the plan you would choose for a growing team.",
      "Compare the two plans that seem most relevant.",
      "Find out whether you can change plans later.",
      "Locate help for a question you still have.",
      "Explain what you would do next.",
    ];
    await page.getByRole("textbox", { name: "Task 1", exact: true }).fill(tasks[0]);
    for (let index = 1; index < tasks.length; index += 1) {
      await page.getByRole("button", { name: "Add task" }).click();
      await page.getByRole("textbox", { name: `Task ${index + 1}`, exact: true }).fill(tasks[index]);
    }
    await page.getByRole("heading", { name: "New research study" }).scrollIntoViewIfNeeded();
    return;
  }

  await page.getByRole("button", { name: /Use chat/i }).click();
  await page.getByTitle(/Live product for/i).waitFor();
}

test.describe("docs screenshots", () => {
  test.use({
    storageState: process.env.DOCS_SESSION_FILE
      ? process.env.DOCS_SESSION_FILE
      : FUNCTIONAL
        ? "e2e/functional/.auth/user.json"
        : undefined,
  });

  for (const entry of PAGES) {
    const { file, url } = entry;
    test(`capture ${file}`, async ({ page }) => {
      if ("viewport" in entry && entry.viewport) await page.setViewportSize(entry.viewport);
      if ("prepare" in entry && entry.prepare === "participant-chat") {
        await page.route("https://example.com/**", async (route) => route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><style>body{font-family:system-ui;margin:0;padding:40px;color:#172033;background:#f7f8fb}main{max-width:620px;margin:auto}h1{font-size:32px}.plans{display:grid;grid-template-columns:1fr 1fr;gap:16px}.plan{background:white;border:1px solid #dfe3ea;border-radius:16px;padding:20px}.primary{border-color:#ff6600}</style><main><p>Acme workspace</p><h1>Choose a plan for your team</h1><div class=plans><section class=plan><h2>Starter</h2><p>For small teams learning the basics.</p></section><section class='plan primary'><h2>Growth</h2><p>For teams coordinating continuous discovery.</p></section></div></main>",
        }));
      }
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      if ("scrollToHeading" in entry && entry.scrollToHeading) {
        await page.getByRole("heading", { name: entry.scrollToHeading }).scrollIntoViewIfNeeded();
      }
      if ("prepare" in entry && entry.prepare) await prepareScreenshot(page, entry);
      // Give dynamic content a moment to settle
      await page.waitForTimeout(800);
      await page.screenshot({
        path: path.join(OUT, file),
        fullPage: "fullPage" in entry ? entry.fullPage ?? false : false,
        animations: "disabled",
      });
      console.log(`Saved ${file}`);
    });
  }
});
