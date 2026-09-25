import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Regression guard for the `vercel-protection-bypass` rule in .gitleaks.toml.
 *
 * Context: a Vercel deployment-protection bypass secret is a bare 32-character
 * alphanumeric string with no distinguishing prefix, and the gitleaks default
 * ruleset does NOT catch it — `x-vercel-protection-bypass` contains none of the
 * keywords `generic-api-key` requires. A hardcoded one therefore passes a
 * default scan silently, which is why this repo carries a custom rule. This
 * file asserts the rule still exists and still behaves.
 *
 * The offending fixture lines are composed at runtime from FIXTURE_BYPASS_VALUE
 * rather than written out as literals, so this test file does not itself
 * contain a line the rule matches. That keeps the repo scan clean without
 * needing an allowlist entry that would weaken the rule.
 */

const CONFIG_PATH = resolve(process.cwd(), ".gitleaks.toml");
const configSource = readFileSync(CONFIG_PATH, "utf8");

const RULE_ID = "vercel-protection-bypass";
const HEADER_NAME = "x-vercel-protection-bypass";
const ENV_NAME = "VERCEL_AUTOMATION_BYPASS_SECRET";

// Synthetic stand-in for the historical value: same shape (bare alphanumerics,
// no prefix, 20-64 chars), no relationship to any real credential.
const FIXTURE_BYPASS_VALUE = "ExampleOnlyNotARealBypass000000";

const LEAKED_HEADER_LINE = `        "${HEADER_NAME}": "${FIXTURE_BYPASS_VALUE}",`;
const LEAKED_ENV_LINE = `${ENV_NAME}="${FIXTURE_BYPASS_VALUE}"`;
const SAFE_HEADER_LINE = `        "${HEADER_NAME}": process.env.${ENV_NAME},`;

/**
 * Returns the body of the `[[rules]]` block with the given id, with comment
 * lines stripped and everything from the next top-level table onward dropped —
 * so assertions below test declarations, not prose about them.
 */
function extractRule(id: string): string {
  const block = configSource
    .split(/^\[\[rules\]\]$/m)
    .find((section) => new RegExp(`^\\s*id\\s*=\\s*"${id}"`, "m").test(section));

  if (!block) {
    throw new Error(`No [[rules]] block with id = "${id}" in .gitleaks.toml`);
  }

  const lines: string[] = [];
  for (const line of block.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    // A top-level table (e.g. `[allowlist]`) ends this rule's block; a nested
    // `[[rules.allowlists]]` belongs to it and is kept.
    if (/^\[/.test(line) && !/^\[\[rules\./.test(line)) break;
    lines.push(line);
  }

  return lines.join("\n");
}

function compiledRuleRegex(id: string): RegExp {
  const match = extractRule(id).match(/^regex\s*=\s*'''([\s\S]*?)'''/m);

  if (!match) {
    throw new Error(`Rule "${id}" declares no regex`);
  }

  // Go's RE2 spells case-insensitivity as an inline (?i) flag; JS needs /i.
  const pattern = match[1].replace(/^\(\?i\)/, "");
  const flags = match[1].startsWith("(?i)") ? "i" : "";

  return new RegExp(pattern, flags);
}

describe("gitleaks vercel-protection-bypass rule (config)", () => {
  it("is still declared in .gitleaks.toml", () => {
    expect(configSource).toContain(`id = "${RULE_ID}"`);
  });

  it("reports only the credential, not the whole line", () => {
    expect(extractRule(RULE_ID)).toMatch(/^secretGroup\s*=\s*1$/m);

    const captured = compiledRuleRegex(RULE_ID).exec(LEAKED_HEADER_LINE);
    expect(captured?.[1]).toBe(FIXTURE_BYPASS_VALUE);
  });

  it("matches a bypass credential assigned to the header", () => {
    expect(compiledRuleRegex(RULE_ID).test(LEAKED_HEADER_LINE)).toBe(true);
  });

  it("matches a bypass credential assigned to the env var name", () => {
    expect(compiledRuleRegex(RULE_ID).test(LEAKED_ENV_LINE)).toBe(true);
  });

  it("ignores the correct pattern of reading the value from the environment", () => {
    expect(compiledRuleRegex(RULE_ID).test(SAFE_HEADER_LINE)).toBe(false);
  });

  it("keeps the header keyword that gates the rule", () => {
    // gitleaks only evaluates a rule's regex on content containing one of its
    // keywords, so dropping the keyword silently disarms the rule.
    expect(extractRule(RULE_ID)).toContain(`"${HEADER_NAME}"`);
  });

  it("has no allowlist that could suppress a real finding", () => {
    expect(extractRule(RULE_ID)).not.toContain("[[rules.allowlists]]");
  });
});

function gitleaksAvailable(): boolean {
  try {
    execFileSync("gitleaks", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasGitleaks = gitleaksAvailable();
const scratchDirs: string[] = [];

/** Runs gitleaks over a throwaway directory holding a single file. */
function scanContent(content: string): { exitCode: number; findings: number } {
  const dir = mkdtempSync(join(tmpdir(), "gitleaks-bypass-"));
  scratchDirs.push(dir);
  writeFileSync(join(dir, "playwright.config.ts"), content);
  const reportPath = join(dir, "report.json");

  let exitCode = 0;
  try {
    execFileSync(
      "gitleaks",
      [
        "dir",
        dir,
        "--config",
        CONFIG_PATH,
        "--report-format",
        "json",
        "--report-path",
        reportPath,
        "--redact",
        "--no-banner",
        "--log-level",
        "error",
        "--exit-code",
        "1",
      ],
      { stdio: "ignore" },
    );
  } catch (error) {
    exitCode = (error as { status?: number }).status ?? -1;
  }

  const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
    RuleID: string;
  }>;

  return {
    exitCode,
    findings: report.filter((f) => f.RuleID === RULE_ID).length,
  };
}

afterAll(() => {
  for (const dir of scratchDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Skipped where the gitleaks binary is absent (e.g. the unit-test CI job, which
// does not install it). The config assertions above run unconditionally.
describe.skipIf(!hasGitleaks)(
  "gitleaks vercel-protection-bypass rule (binary)",
  () => {
    it("fails the scan on a hardcoded bypass credential", () => {
      const result = scanContent(
        `export default {\n  use: {\n    extraHTTPHeaders: {\n${LEAKED_HEADER_LINE}\n    },\n  },\n};\n`,
      );

      expect(result.findings).toBeGreaterThan(0);
      expect(result.exitCode).toBe(1);
    });

    it("passes the scan when the value comes from the environment", () => {
      const result = scanContent(
        `export default {\n  use: {\n    extraHTTPHeaders: {\n${SAFE_HEADER_LINE}\n    },\n  },\n};\n`,
      );

      expect(result.findings).toBe(0);
      expect(result.exitCode).toBe(0);
    });
  },
);
