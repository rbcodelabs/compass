/**
 * Doc Inline Anchored Comments functional spec.
 *
 * Journey: Create a doc via the UI → type content → select a word → add an
 *          anchored comment → verify the highlight decoration lands on the
 *          selected text AND the comment appears in the sidebar → reply to the
 *          thread → resolve it → confirm the thread is hidden from the default
 *          open-only view and its highlight is gone.
 *
 * Self-seeds a fresh doc (no Doc rows are seeded in seed-e2e.ts), mirroring
 * e2e/functional/specs/doc-version-history.spec.ts.
 */
import { test, expect } from "../fixtures/index";

test.describe("Doc Inline Comments", () => {
  test(
    "select text → comment → highlight + sidebar → reply → resolve hides from open view",
    async ({ page, base }) => {
      const ts = Date.now();
      const docTitle = `E2E Inline Comments Doc ${ts}`;
      const anchorWord = "REVIEW";
      const content = `${anchorWord} this sentence now ${ts}`;
      const commentBody = `Please rework this ${ts}`;
      const replyBody = `Agreed, on it ${ts}`;

      // ── 1. Create a fresh doc ──────────────────────────────────────────────
      await page.goto(`${base}/docs`);
      await page.waitForLoadState("networkidle");
      await page.getByRole("button", { name: "New" }).click();
      await page.waitForURL(/\/docs\/[0-9a-f-]+$/, { timeout: 15_000 });

      const editor = page.locator(".ProseMirror");
      await expect(editor).toBeVisible({ timeout: 10_000 });

      // ── 2. Title ───────────────────────────────────────────────────────────
      const titleInput = page.getByPlaceholder("Untitled");
      await titleInput.fill(docTitle);
      await titleInput.blur();

      // ── 3. Type content ────────────────────────────────────────────────────
      await editor.click();
      await page.keyboard.type(content);
      // Past the 1200ms autosave debounce (components/docs/doc-editor.tsx).
      await page.waitForTimeout(1800);

      // ── 4. Select the first word ("REVIEW") deterministically via keyboard ──
      await page.keyboard.press("Home");
      for (let i = 0; i < anchorWord.length; i++) {
        await page.keyboard.press("Shift+ArrowRight");
      }

      // ── 5. Add an anchored comment on the selection ────────────────────────
      const commentButton = page.getByTitle("Comment on selection");
      await expect(commentButton).toBeEnabled({ timeout: 10_000 });
      await commentButton.click();

      const composer = page.getByPlaceholder("Add a comment…");
      await expect(composer).toBeVisible({ timeout: 10_000 });
      await composer.fill(commentBody);
      await page.getByRole("button", { name: "Comment", exact: true }).click();

      // ── 6. Highlight decoration lands on the anchored text ─────────────────
      const highlight = page.locator(".doc-comment-highlight");
      await expect(highlight).toBeVisible({ timeout: 10_000 });
      await expect(highlight).toContainText(anchorWord);

      // ── 7. Sidebar shows the thread ────────────────────────────────────────
      const commentsList = page.getByTestId("doc-comments-list");
      await expect(commentsList).toBeVisible({ timeout: 10_000 });
      await expect(commentsList).toContainText(commentBody);
      const thread = page.getByTestId("doc-comment-thread");
      await expect(thread).toHaveCount(1);

      // ── 8. Reply to the thread ─────────────────────────────────────────────
      const replyBox = page.getByPlaceholder("Reply…");
      await expect(replyBox).toBeVisible({ timeout: 10_000 });
      await replyBox.fill(replyBody);
      await page.getByRole("button", { name: "Reply", exact: true }).click();
      await expect(commentsList).toContainText(replyBody, { timeout: 10_000 });

      // ── 9. Resolve → thread hidden from the default open-only view ─────────
      await page.getByRole("button", { name: "Resolve", exact: true }).click();
      await expect(page.getByTestId("doc-comment-thread")).toHaveCount(0, { timeout: 10_000 });
      await expect(commentsList).not.toContainText(commentBody);
      // The highlight for a resolved comment is removed too.
      await expect(page.locator(".doc-comment-highlight")).toHaveCount(0, { timeout: 10_000 });

      // ── 10. Resolved thread is still reachable behind the toggle ───────────
      const showResolved = page.getByRole("button", { name: /Show resolved/ });
      await expect(showResolved).toBeVisible({ timeout: 10_000 });
      await showResolved.click();
      await expect(commentsList).toContainText(commentBody);
    }
  );
});
