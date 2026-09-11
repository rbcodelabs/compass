import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  E2E_DATABASE_GUARD_ENV,
  requireIsolatedE2EDatabaseMode,
  validateIsolatedE2EDatabaseTarget,
  validateIsolatedE2ESentinel,
} from "../e2e/functional/fixtures/isolated-database";

describe("isolated authenticated E2E database guard", () => {
  afterEach(() => vi.unstubAllEnvs());

  test.each([
    "postgresql://postgres:postgres@localhost:5432/compass_e2e",
    "postgresql://postgres:postgres@127.0.0.1:5432/compass_e2e",
    "postgresql://postgres:postgres@[::1]:5432/compass_e2e",
  ])("accepts the dedicated local database: %s", (connectionString) => {
    expect(() =>
      validateIsolatedE2EDatabaseTarget(connectionString, "compass_dev"),
    ).not.toThrow();
  });

  test("rejects a remote database before setup or teardown can mutate it", () => {
    expect(() =>
      validateIsolatedE2EDatabaseTarget(
        "postgresql://postgres:postgres@db.example.com:5432/compass_e2e",
        "compass_dev",
      ),
    ).toThrow("refuses non-local Postgres host");
  });

  test("rejects a generic local database", () => {
    expect(() =>
      validateIsolatedE2EDatabaseTarget(
        "postgresql://postgres:postgres@localhost:5432/postgres",
        "compass_dev",
      ),
    ).toThrow("requires database compass_e2e");
  });

  test("rejects the wrong schema", () => {
    expect(() =>
      validateIsolatedE2EDatabaseTarget(
        "postgresql://postgres:postgres@localhost:5432/compass_e2e",
        "public",
      ),
    ).toThrow("requires schema compass_dev");
  });

  test("requires explicit isolated-database mode", () => {
    vi.stubEnv(E2E_DATABASE_GUARD_ENV, "");
    expect(() => requireIsolatedE2EDatabaseMode()).toThrow(
      `requires ${E2E_DATABASE_GUARD_ENV}=1`,
    );

    vi.stubEnv(E2E_DATABASE_GUARD_ENV, "1");
    expect(() => requireIsolatedE2EDatabaseMode()).not.toThrow();
  });

  test("accepts only the exact bootstrap sentinel", () => {
    expect(() =>
      validateIsolatedE2ESentinel([{ value: "compass-authenticated-e2e" }]),
    ).not.toThrow();
    expect(() => validateIsolatedE2ESentinel([])).toThrow(
      "isolated-database sentinel is absent",
    );
    expect(() =>
      validateIsolatedE2ESentinel([{ value: "not-the-e2e-database" }]),
    ).toThrow("isolated-database sentinel is absent");
    expect(() =>
      validateIsolatedE2ESentinel([
        { value: "compass-authenticated-e2e" },
        { value: "compass-authenticated-e2e" },
      ]),
    ).toThrow("isolated-database sentinel is absent");
  });
});

describe("safety-baseline workflow contract", () => {
  test("pins the local and CI toolchain", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"),
    ) as { packageManager?: string; engines?: { node?: string; pnpm?: string } };
    const nodeVersion = fs
      .readFileSync(path.resolve(process.cwd(), ".node-version"), "utf8")
      .trim();

    expect(packageJson.packageManager).toMatch(/^pnpm@10\./);
    expect(packageJson.engines).toEqual({ node: "22.x", pnpm: "10.x" });
    expect(nodeVersion).toBe("22");
  });

  test("CI runs typecheck, optimized build, and the bounded authenticated suite", () => {
    const workflow = fs.readFileSync(
      path.resolve(process.cwd(), ".github/workflows/ui-system.yml"),
      "utf8",
    );

    expect(workflow).toContain("run: pnpm typecheck");
    expect(workflow).toContain("run: pnpm build");
    expect(workflow).toContain("run: pnpm test:e2e:roadmap");
    expect(workflow).toContain("run: pnpm e2e:db:verify-clean");
    expect(workflow).toContain("postgres:");
  });

  test("the authenticated command is exactly the three-test roadmap subset", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts["test:e2e:roadmap"]).toBe(
      "node scripts/run-functional-e2e.mjs roadmap",
    );
    expect(packageJson.scripts["test:e2e:functional"]).toBe(
      "node scripts/run-functional-e2e.mjs functional",
    );
    expect(packageJson.scripts["test:e2e:all"]).toBe(
      "node scripts/run-functional-e2e.mjs all",
    );
  });

  test("every functional entry point prepares and verifies its isolated database", () => {
    const runner = fs.readFileSync(
      path.resolve(process.cwd(), "scripts/run-functional-e2e.mjs"),
      "utf8",
    );

    expect(runner.indexOf("scripts/prepare-e2e-database.mjs")).toBeLessThan(
      runner.indexOf("@playwright/test/cli.js"),
    );
    expect(runner.indexOf("scripts/verify-e2e-cleanup.mjs")).toBeGreaterThan(
      runner.indexOf("@playwright/test/cli.js"),
    );
    expect(runner).toContain('E2E_ISOLATED_DATABASE: "1"');
    expect(runner).toContain('CI: "1"');
    expect(runner).toContain('"--retries=0"');
  });

  test("teardown refuses cleanup when setup did not establish run ownership", () => {
    const teardown = fs.readFileSync(
      path.resolve(process.cwd(), "e2e/functional/global-teardown.ts"),
      "utf8",
    );
    const missingToken = teardown.indexOf("if (!runToken)");

    expect(missingToken).toBeGreaterThan(-1);
    expect(teardown.indexOf("return;", missingToken)).toBeLessThan(
      teardown.indexOf("const pool = new pg.Pool"),
    );
    expect(teardown).not.toContain("cleaning up by slug (legacy");
  });
});
