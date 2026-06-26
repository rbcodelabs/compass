import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    // Exclude Playwright e2e specs and worktree test copies
    exclude: [
      "**/node_modules/**",
      "**/e2e/**",
      "**/.claude/worktrees/**",
    ],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: [
        "lib/**/*.ts",
        "app/**/actions.ts",
        "app/api/**/*.ts",
      ],
      exclude: [
        "**/node_modules/**",
        "**/.claude/**",
        "lib/db.ts",
        "lib/mcp-auth.ts",
      ],
    },
  },
});
