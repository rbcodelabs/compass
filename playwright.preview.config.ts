import { defineConfig } from "@playwright/test"
export default defineConfig({
  testDir: "./e2e/preview", workers: 1, retries: 0, timeout: 60_000,
  reporter: [["line"]], outputDir: "preview-report/results",
  use: { baseURL: process.env.PREVIEW_ORIGIN, storageState: process.env.PREVIEW_OWNER_STATE, trace: "off", video: "off", screenshot: "off", serviceWorkers: "block" },
  projects: [{ name: "desktop", use: { viewport: { width: 1440, height: 1000 } } }, { name: "tablet", use: { viewport: { width: 768, height: 1024 } } }, { name: "mobile", use: { viewport: { width: 390, height: 844 } } }],
})
