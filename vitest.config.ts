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
    // The workspace-layout / faceted-filter suites mount real component trees
    // (dnd-kit, the roadmap timeline, DataGrid). Those cold imports are paid
    // inside the first test of each file and routinely exceed the 5s default
    // once the full suite is running workers in parallel on a loaded machine —
    // producing timeouts that move between files run to run. Budget for the
    // import cost rather than letting contention decide which tests fail.
    testTimeout: 30_000,
    hookTimeout: 30_000,
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
