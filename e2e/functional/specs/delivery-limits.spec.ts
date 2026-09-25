/**
 * Delivery (WIP) Limits functional spec.
 *
 * Journey: Settings → Delivery limits — set a NOW and a NEXT limit, confirm
 *          they persist across reload, then confirm the roadmap board's NOW
 *          and NEXT column headers switch from a bare count to "count/limit"
 *          and that the NOW badge visibly turns to a warning tone once its
 *          count exceeds the limit — while adding an item that pushes NOW
 *          over its limit still succeeds with no error or blocking of any
 *          kind (the whole feature is purely visual/advisory; see
 *          docs/decisions/0005-compass-native-decision-gates.md and 0006,
 *          both Superseded, for why this must never grow into enforcement).
 *
 * Mutates the shared seeded e2e workspace's `nowLimit`/`nextLimit` settings
 * and adds one roadmap item, so this is `.serial()` and cleans both up at
 * the end regardless of where along the way an assertion might fail.
 */
import { test, expect } from "../fixtures/index";

test.describe.serial("Delivery limits", () => {
  test(
    "set NOW/NEXT limits in Settings, persist across reload, board reflects count/limit and warns over limit without blocking",
    async ({ page, base }) => {
      const itemTitle = `E2E Delivery Limit Item ${Math.random().toString(36).slice(2, 10)}`;

      try {
        // ── 1. Set both limits in Settings ──────────────────────────────────
        await page.goto(`${base}/settings`);
        await page.waitForLoadState("networkidle");

        const nowLimitInput = page.getByTestId("now-limit-input");
        const nextLimitInput = page.getByTestId("next-limit-input");

        // NOW gets 0 so any pre-existing (or newly added) item pushes it over
        // the limit. NEXT gets a high number so it stays comfortably under —
        // this covers both the "count/limit" display and the no-warning case
        // in the same run. Both fields share one `isPending` (from a single
        // useTransition), so waiting for the field to become enabled again
        // between edits guarantees the first save's server action has fully
        // round-tripped before the second one starts — otherwise the two
        // overlapping saves can race (observed directly: the second value
        // was silently dropped without this wait).
        await nowLimitInput.fill("0");
        await nowLimitInput.blur();
        await expect(nowLimitInput).toBeEnabled();
        await page.waitForLoadState("networkidle");

        await nextLimitInput.fill("999");
        await nextLimitInput.blur();
        await expect(nextLimitInput).toBeEnabled();
        await page.waitForLoadState("networkidle");

        // ── 2. Reload and confirm both values persisted server-side ────────
        await page.reload();
        await page.waitForLoadState("networkidle");
        await expect(page.getByTestId("now-limit-input")).toHaveValue("0");
        await expect(page.getByTestId("next-limit-input")).toHaveValue("999");

        // ── 3. Roadmap board: NOW/NEXT headers show "count/limit" ──────────
        await page.goto(`${base}/roadmap`);
        await page.waitForLoadState("networkidle");

        const nowColumn = page.locator("section:has(#roadmap-column-NOW)");
        const nextColumn = page.locator("section:has(#roadmap-column-NEXT)");

        const nowBadgeBefore = nowColumn.getByLabel(/of 0 items$/);
        await expect(nowBadgeBefore).toBeVisible();
        const beforeText = (await nowBadgeBefore.textContent())!.trim();
        const [beforeCountStr, beforeLimitStr] = beforeText.split("/");
        expect(beforeLimitStr).toBe("0");
        const beforeCount = Number(beforeCountStr);

        const nextBadge = nextColumn.getByLabel(/of 999 items$/);
        await expect(nextBadge).toBeVisible();
        await expect(nextBadge).toHaveText(/^\d+\/999$/);

        // NEXT is nowhere near 999 — confirm it did NOT pick up the warning tone.
        const nextIsWarning = await page.evaluate(() => {
          const el = document.querySelector('[aria-label$="of 999 items"]');
          const reference = document.createElement("span");
          reference.className = "bg-status-warning-surface";
          document.body.appendChild(reference);
          const elColor = el ? getComputedStyle(el).backgroundColor : null;
          const warningColor = getComputedStyle(reference).backgroundColor;
          reference.remove();
          return elColor === warningColor;
        });
        expect(nextIsWarning).toBe(false);

        // ── 4. Add an item to NOW — confirm it succeeds with zero blocking ──
        // (no error text, no confirmation dialog) even though NOW is already
        // at/over its limit of 0.
        await nowColumn.getByRole("button", { name: "Add item" }).click();
        await nowColumn.getByLabel("Title").fill(itemTitle);
        await nowColumn.getByRole("button", { name: "Add Item" }).click();
        await page.waitForLoadState("networkidle");

        await expect(page.getByText(itemTitle)).toBeVisible();
        // No error/confirmation surface of any kind appeared.
        await expect(page.getByRole("dialog")).toHaveCount(0);
        // Scope to the app's own DOM. getByText pierces open shadow roots, so an
        // unscoped match also counts the Next.js dev overlay — a
        // <nextjs-portal> shadow host that Next mounts under a body-level
        // <script> — which lists any console error from the page load. After a
        // few /roadmap renders that includes the dnd-kit `DndDescribedBy-N`
        // hydration mismatch. That is dev-only tooling, not a limit-related
        // error surface; every app element (root and portals) is a non-script
        // child of <body>.
        await expect(page.locator("body > :not(script)").getByText(/error/i)).toHaveCount(0);

        // ── 5. NOW badge now reads (beforeCount+1)/0 and is visibly warning ─
        const nowBadgeAfter = nowColumn.getByLabel(/of 0 items$/);
        await expect(nowBadgeAfter).toHaveText(`${beforeCount + 1}/0`);

        const nowIsWarning = await page.evaluate(() => {
          const el = document.querySelector('[aria-label$="of 0 items"]');
          const reference = document.createElement("span");
          reference.className = "bg-status-warning-surface";
          document.body.appendChild(reference);
          const elColor = el ? getComputedStyle(el).backgroundColor : null;
          const warningColor = getComputedStyle(reference).backgroundColor;
          reference.remove();
          return elColor === warningColor;
        });
        expect(nowIsWarning).toBe(true);
      } finally {
        // ── Cleanup: archive the item this test added, then clear both limits ──
        await page.goto(`${base}/roadmap`);
        await page.waitForLoadState("networkidle");

        const card = page.locator(`div.group:has-text("${itemTitle}")`).first();
        if (await card.count()) {
          await card.getByLabel("Card actions").click();
          await page.getByRole("menuitem", { name: "Archive" }).click();
          await page.waitForLoadState("networkidle");
        }

        await page.goto(`${base}/settings`);
        await page.waitForLoadState("networkidle");
        const nowLimitInput = page.getByTestId("now-limit-input");
        const nextLimitInput = page.getByTestId("next-limit-input");
        await nowLimitInput.fill("");
        await nowLimitInput.blur();
        await expect(nowLimitInput).toBeEnabled();
        await page.waitForLoadState("networkidle");
        await nextLimitInput.fill("");
        await nextLimitInput.blur();
        await expect(nextLimitInput).toBeEnabled();
        await page.waitForLoadState("networkidle");
      }
    }
  );
});
