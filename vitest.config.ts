import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
  test: {
    // Exclude Playwright e2e specs — they run via `pnpm test:e2e`
    // Exclude e2e specs (run via `pnpm test:e2e`) and nested worktrees
    exclude: ["**/node_modules/**", "**/e2e/**", "**/.claude/worktrees/**"],
    environment: "node",
    include: ["**/__tests__/**/*.test.ts"],
  },
});
