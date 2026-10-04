import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

test.use({ storageState: { cookies: [], origins: [] } });
async function capture(page: Page, name: string) {
  if (process.env.EXPLORER_SCREENSHOTS !== "1") return;
  await mkdir("public/screenshots/docs", { recursive: true });
  await page.screenshot({
    path: path.join("public/screenshots/docs", `api-explorer-${name}.png`),
    fullPage: true,
  });
}
const meLink = "/help/api-explorer#operation=getCurrentIdentity";
test("deployment cookies load the contract without authorizing cookie-free API reads", async ({
  page,
  baseURL,
}) => {
  const response = await page.request.get("/api/v1/openapi.json");
  expect(response.ok()).toBeTruthy();
  const contract = await response.json();
  await page
    .context()
    .addCookies([
      { name: "synthetic-deployment-access", value: "allowed", url: baseURL! },
    ]);
  await page.route("**/api/v1/openapi.json", async (route) => {
    const headers = await route.request().allHeaders();
    if (!headers.cookie?.includes("synthetic-deployment-access=allowed")) {
      await route.fulfill({
        status: 302,
        headers: { Location: "/synthetic-protection-login" },
      });
      return;
    }
    expect(headers.authorization).toBeUndefined();
    await route.fulfill({ status: 200, json: contract });
  });
  let calls = 0;
  await page.route("**/api/v1/me", async (route) => {
    calls++;
    const headers = await route.request().allHeaders();
    expect(headers.cookie).toBeUndefined();
    expect(headers.authorization).toBe("Bearer synthetic");
    await route.fulfill({
      status: 302,
      headers: { Location: "/synthetic-protection-login" },
    });
  });
  await page.goto(meLink);
  await expect(
    page.getByRole("button", { name: "Send GET request" }),
  ).toBeVisible();
  await page.getByLabel("API key or OAuth bearer token").fill("synthetic");
  await page.getByRole("button", { name: "Send GET request" }).click();
  await expect(page.getByRole("status")).toContainText("Request failed.");
  expect(calls).toBe(1);
  expect(page.url()).not.toContain("synthetic-protection-login");
});
test("anonymous explorer uses the generated inventory, browses writes and never sends automatically", async ({
  page,
}) => {
  const contractResponse = await page.request.get("/api/v1/openapi.json");
  expect(contractResponse.ok()).toBeTruthy();
  const contract = await contractResponse.json();
  const inventory = Object.values(contract.paths).flatMap((item) =>
    Object.entries(item as Record<string, unknown>).filter(([method]) =>
      [
        "get",
        "post",
        "put",
        "patch",
        "delete",
        "head",
        "options",
        "trace",
      ].includes(method),
    ),
  );
  let calls = 0;
  await page.route("**/api/v1/me", async (route) => {
    calls++;
    await route.fulfill({ status: 200, json: { user: { id: "synthetic" } } });
  });
  await page.goto(meLink);
  await expect(
    page.getByRole("heading", { name: "Explore the Compass API" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      `OpenAPI ${contract.openapi} · ${inventory.length} operations`,
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send GET request" }),
  ).toBeVisible();
  await capture(page, "desktop");
  await page.getByLabel("Find an operation").fill("POST");
  await page
    .getByRole("navigation", { name: "API operations" })
    .getByRole("button")
    .first()
    .click();
  await expect(page.getByText(/Execution is disabled/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send GET request" }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "Schema", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Raw operation schema" }),
  ).toBeVisible();
  expect(calls).toBe(0);
});

test("explicit authenticated reads render 200, 401 and 404 safely, reset and reload erase state", async ({
  page,
}) => {
  let status = 200,
    calls = 0;
  const token = "synthetic-explorer-private-sentinel";
  await page.route("**/api/v1/me", async (route) => {
    calls++;
    expect(route.request().method()).toBe("GET");
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    expect(route.request().headers().cookie).toBeUndefined();
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify({
        status,
        detail: '<img src=x onerror="window.hacked=true">',
      }),
    });
  });
  await page.goto(meLink);
  await page.getByLabel("API key or OAuth bearer token").fill(token);
  expect(calls).toBe(0);
  for (const code of [200, 401, 404]) {
    status = code;
    await page.getByRole("tab", { name: "Request", exact: true }).click();
    await page.getByRole("button", { name: "Send GET request" }).click();
    await expect(page.getByRole("status")).toContainText(`${code} ·`);
    await expect(page.locator("pre")).toContainText("onerror");
    await expect(page.locator("img")).toHaveCount(0);
  }
  await capture(page, "error");
  await page.getByRole("tab", { name: "Examples", exact: true }).click();
  for (const example of await page.locator("pre").allTextContents())
    expect(example).not.toContain(token);
  expect(page.url()).not.toContain(token);
  expect(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
    })),
  ).toEqual({ local: 0, session: 0 });
  await page.getByRole("button", { name: "Reset session" }).click();
  await page.getByRole("tab", { name: "Request", exact: true }).click();
  await expect(page.getByLabel("API key or OAuth bearer token")).toHaveValue(
    "",
  );
  await page.getByRole("tab", { name: "Response", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("No request sent");
  await page.reload();
  await expect(page.getByLabel("API key or OAuth bearer token")).toHaveValue(
    "",
  );
  expect(calls).toBe(3);
});

test("mobile drawer supports keyboard closing and narrow layout without overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(meLink);
  await expect(
    page.getByRole("button", { name: "Send GET request" }),
  ).toBeVisible();
  await capture(page, "mobile");
  const browse = page.getByRole("button", { name: "Browse operations" });
  await browse.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("Find an operation").fill("GET workspace tasks");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(browse).toBeFocused();
  await expect(
    page.getByRole("navigation", { name: "User Guide navigation" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
  ).toBe(false);
});
