import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Exclude Playwright e2e specs — they run via `pnpm test:e2e`
    exclude: ["**/node_modules/**", "**/e2e/**"],
    environment: "node",
  },
});
