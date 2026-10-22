/**
 * Functional coverage for the chain graph (docs/design/chain-graph.md), flag-gated: `pnpm dev` runs NODE_ENV=development,
 * which turns the graph on (lib/chain-graph/flag.ts).
 *
 * Seeds Opportunity -> Solution -> Assumption through the UI (same journey as assumption-experiment-linking.spec.ts), then:
 * deep-links with a display ID, checks the outline lists upstream and downstream, clears the trace, collapses and expands a
 * cluster from the keyboard, opens the detail panel from the outline, reloads (the deep link survives), and follows the
 * "View chain" action from the panel. The graph canvas itself is a React Flow surface; the outline is the accessible
 * representation, so assertions go through it.
 *
 * NOT RUN in the authoring environment (no Postgres or docker there); it type-checks and follows the sibling specs' patterns.
 */
import { test, expect } from "../fixtures/index";
import { createOpportunityFromBoard } from "../fixtures/opportunity-composer";
import { openFullPage } from "../fixtures/full-page";

test.describe("Chain graph", () => {
  test("deep link traces the chain, clusters collapse by keyboard, and the panel links in", async ({ page, base }) => {
    const ts = Date.now();
    const oppTitle = `E2E Graph Opportunity ${ts}`;
    const solTitle = `E2E Graph Solution ${ts}`;
    const assumptionTitle = `E2E Graph Assumption ${ts}`;

    const KNOWN = ["DndDescribedBy"];
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (KNOWN.some((s) => text.includes(s))) return;
      consoleErrors.push(text);
    });
    page.on("pageerror", (err) => consoleErrors.push(err.message));

    // ── Seed: opportunity -> solution -> assumption ─────────────────────────
    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");
    await createOpportunityFromBoard(page, oppTitle);
    await expect(page.getByText(oppTitle)).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: oppTitle, exact: true }).click();

    // The panel offers "View chain" for an Opportunity; keep its href for step 5.
    const panel = page.locator('[data-slot="sheet-content"]');
    await expect(panel).toBeVisible();
    const viewChain = panel.getByRole("link", { name: "View chain" });
    await expect(viewChain).toBeVisible();
    const viewChainHref = await viewChain.getAttribute("href");
    expect(viewChainHref).toMatch(/\/graph\?focus=OPPORTUNITY%3A/);

    await openFullPage(page, panel);
    await page.waitForLoadState("networkidle");
    // The full-page URL carries the canonical reference (display ID such as OPP-12, or the UUID).
    const oppRef = decodeURIComponent(new URL(page.url()).pathname.split("/").pop() ?? "");
    expect(oppRef.length).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Add Solution" }).click();
    await page.getByLabel("Title").fill(solTitle);
    await page.getByRole("button", { name: "Add Solution" }).last().click();
    await expect(page.getByText(solTitle)).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: solTitle, exact: true }).click();
    const solPanel = page.locator('[data-slot="sheet-content"]');
    await expect(solPanel).toBeVisible();
    await solPanel.getByRole("button", { name: "Add Assumption" }).click();
    await solPanel.getByPlaceholder("Assumption title").fill(assumptionTitle);
    await solPanel.getByRole("button", { name: "Add", exact: true }).click();
    await expect(solPanel.getByText(assumptionTitle).first()).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(solPanel).not.toBeVisible({ timeout: 10_000 });

    // ── 1. Deep link by reference (display ID or UUID): selected and traced ──
    const graphUrl = `${base}/graph?focus=${encodeURIComponent(`OPPORTUNITY:${oppRef}`)}`;
    await page.goto(graphUrl);
    await page.waitForLoadState("networkidle");
    const outline = page.getByRole("complementary", { name: "Chain outline" });
    await expect(outline).toBeVisible();
    await expect(outline.getByRole("region", { name: "Selection" }).getByText(oppTitle)).toBeVisible();
    await expect(outline.getByRole("region", { name: "Downstream" }).getByText(solTitle)).toBeVisible();
    await expect(outline.getByRole("region", { name: "Downstream" }).getByText(assumptionTitle)).toBeVisible();

    // ── 2. A bare display ID resolves too (only when the opportunity has one) ─
    if (/^[A-Z]+-\d+$/.test(oppRef)) {
      await page.goto(`${base}/graph?focus=${encodeURIComponent(oppRef)}`);
      await expect(page.getByRole("complementary", { name: "Chain outline" }).getByRole("region", { name: "Selection" }).getByText(oppTitle)).toBeVisible();
      await page.goto(graphUrl);
    }

    // ── 3. Escape clears the trace; clicking an outline row traces that object ─
    await page.getByRole("complementary", { name: "Chain outline" }).getByRole("region", { name: "Downstream" }).getByRole("button", { name: new RegExp(solTitle) }).click();
    await expect(outline.getByRole("region", { name: "Selection" }).getByText(solTitle)).toBeVisible();
    await expect(outline.getByRole("region", { name: "Upstream" }).getByText(oppTitle)).toBeVisible();
    await page.locator(".chain-graph").press("Escape");
    await expect(outline.getByRole("region", { name: "Selection" })).toHaveCount(0);

    // ── 4. Cluster collapse and expand from the keyboard ─────────────────────
    await page.getByRole("button", { name: "Collapse all" }).click();
    const cluster = page.getByRole("button", { name: /collapsed group of \d+/ }).first();
    await expect(cluster).toBeVisible();
    await cluster.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: new RegExp(`Opportunity: ${oppTitle}`) })).toBeVisible();

    // ── 5. Open details from the outline, and the deep link survives a reload ─
    await page.goto(graphUrl);
    await page.waitForLoadState("networkidle");
    await page.getByRole("complementary", { name: "Chain outline" }).getByRole("button", { name: `Open details for ${solTitle}` }).click();
    await expect(page).toHaveURL(/detail=solution/, { timeout: 10_000 });
    await expect(page.locator('[data-slot="sheet-content"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/focus=OPPORTUNITY/);
    await expect(page.getByRole("complementary", { name: "Chain outline" }).getByRole("region", { name: "Selection" }).getByText(oppTitle)).toBeVisible();

    // ── 6. "View chain" from the panel lands on the same trace ───────────────
    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: oppTitle, exact: true }).click();
    await page.locator('[data-slot="sheet-content"]').getByRole("link", { name: "View chain" }).click();
    await expect(page).toHaveURL(/\/graph\?focus=OPPORTUNITY%3A/, { timeout: 15_000 });
    await expect(page.getByRole("complementary", { name: "Chain outline" }).getByRole("region", { name: "Selection" }).getByText(oppTitle)).toBeVisible();

    expect(consoleErrors).toEqual([]);
  });

  test("an unknown focus is ignored and another workspace's reference does not resolve", async ({ page, base }) => {
    await page.goto(`${base}/graph?focus=${encodeURIComponent("OPPORTUNITY:00000000-0000-4000-8000-000000000000")}`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("complementary", { name: "Chain outline" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Selection" })).toHaveCount(0);
  });
});
