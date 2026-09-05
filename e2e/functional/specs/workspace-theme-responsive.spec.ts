/**
 * Workspace appearance functional coverage.
 *
 * Theme preferences are device-local rather than workspace data, so these
 * tests intentionally exercise localStorage, reloads, and live OS preference
 * changes in a real authenticated workspace. The viewport matrix protects the
 * workspace shell's existing mobile/desktop navigation contract and catches
 * document or settings-content overflow.
 */
import { test, expect } from "../fixtures/index";

const THEME_STORAGE_KEY = "compass-theme";

type FirstFrameTheme = {
  classIsDark: boolean;
  dataTheme: string | undefined;
  colorScheme: string;
};

test.describe("Workspace appearance", () => {
  test("persists Light/Dark/System, follows live system changes, and stays scoped to workspace routes", async ({
    page,
    base,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.addInitScript(({ storageKey }) => {
      // addInitScript runs for every navigation in this context. Seed only the
      // initial value so subsequent reloads can prove user changes persist.
      if (localStorage.getItem(storageKey) === null) {
        localStorage.setItem(storageKey, "dark");
      }
      requestAnimationFrame(() => {
        (
          window as typeof window & {
            __firstFrameThemeSnapshot?: FirstFrameTheme;
          }
        ).__firstFrameThemeSnapshot = {
          classIsDark: document.documentElement.classList.contains("dark"),
          dataTheme: document.documentElement.dataset.theme,
          colorScheme: document.documentElement.style.colorScheme,
        };
      });
    }, { storageKey: THEME_STORAGE_KEY });

    await page.goto(`${base}/settings`);
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    // The server-rendered inline initializer must apply the stored theme before
    // the first animation frame, rather than waiting for React hydration.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as typeof window & {
                __firstFrameThemeSnapshot?: FirstFrameTheme;
              }
            ).__firstFrameThemeSnapshot
        )
      )
      .toEqual({ classIsDark: true, dataTheme: "dark", colorScheme: "dark" });

    const light = page.getByRole("button", { name: "Light", exact: true });
    const dark = page.getByRole("button", { name: "Dark", exact: true });
    const system = page.getByRole("button", { name: "System", exact: true });

    await expect(dark).toHaveAttribute("aria-pressed", "true");
    await light.click();
    await expect(light).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe("light");
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), THEME_STORAGE_KEY))
      .toBe("light");

    // An explicit Light preference wins even while the emulated OS is dark.
    await page.reload();
    await expect(light).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe("light");

    await system.click();
    await expect(system).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe("dark");
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), THEME_STORAGE_KEY))
      .toBe("system");

    await page.emulateMedia({ colorScheme: "light" });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe("light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe("dark");

    // Public/help surfaces sit outside the authenticated workspace theme
    // provider and must not inherit a stored workspace dark class.
    await page.goto("/help");
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBeUndefined();
  });

  for (const viewport of [
    { name: "mobile", width: 390, height: 844, mobileNavigation: true },
    { name: "tablet", width: 768, height: 1024, mobileNavigation: false },
    { name: "desktop", width: 1440, height: 900, mobileNavigation: false },
  ]) {
    test(`${viewport.name} workspace has usable navigation, dark surfaces, and no horizontal overflow`, async ({
      page,
      base,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.addInitScript(({ storageKey }) => {
        localStorage.setItem(storageKey, "dark");
      }, { storageKey: THEME_STORAGE_KEY });

      await page.goto(`${base}/settings`);
      await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
        .toBe("dark");

      const mobileNav = page.getByRole("navigation", { name: "Primary navigation" });
      const desktopNav = page.getByRole("navigation", { name: "Main navigation" });
      if (viewport.mobileNavigation) {
        await expect(mobileNav).toBeVisible();
        await expect(desktopNav).toBeHidden();
      } else {
        await expect(mobileNav).toBeHidden();
        await expect(desktopNav).toBeVisible();
      }

      const layout = await page.evaluate(() => {
        const main = document.querySelector("main");
        const appSurface = document.querySelector<HTMLElement>(".bg-surface-app");
        const rootStyles = getComputedStyle(document.documentElement);
        return {
          viewportWidth: window.innerWidth,
          documentScrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          mainClientWidth: main?.clientWidth ?? null,
          mainScrollWidth: main?.scrollWidth ?? null,
          appBackground: appSurface ? getComputedStyle(appSurface).backgroundColor : null,
          appSurfaceToken: rootStyles.getPropertyValue("--surface-app").trim(),
        };
      });

      expect(layout.documentScrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
      expect(layout.bodyScrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
      expect(layout.mainClientWidth).not.toBeNull();
      expect(layout.mainScrollWidth).toBeLessThanOrEqual(layout.mainClientWidth!);
      expect(layout.appBackground).not.toBe("rgb(255, 255, 255)");
      expect(layout.appSurfaceToken).not.toBe("");

      // All three controls remain tappable and contained at the narrowest
      // supported workspace width.
      const themeButtons = page.getByRole("group", { name: "Color theme" }).getByRole("button");
      await expect(themeButtons).toHaveCount(3);
      if (viewport.mobileNavigation) {
        for (const button of await themeButtons.all()) {
          const box = await button.boundingBox();
          expect(box?.height).toBeGreaterThanOrEqual(44);
          expect(box?.x).toBeGreaterThanOrEqual(0);
          expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
        }
      }
    });
  }
});
