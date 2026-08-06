import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Local parallel-agent worktrees are complete nested checkouts and must
    // not be linted as part of this repository's source tree.
    ".claude/**",
    "coverage/**",
  ]),
  // React 19's advisory rule flags several established state-reset and
  // browser-storage synchronization effects. Keep these visible without
  // making unrelated legacy debt block the repository check.
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  // Playwright fixtures use a callback named `use`; it is not a React hook.
  {
    files: ["e2e/**/*.ts"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },
  {
    files: ["seed-screenshots.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
]);

export default eslintConfig;
