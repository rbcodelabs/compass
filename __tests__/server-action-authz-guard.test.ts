/**
 * Static guard: every function exported from a "use server" module must reach an
 * authorization helper. A server action is a public POST endpoint, so a session
 * check alone (or none) lets any signed-in user act on another tenant's record.
 *
 * "Reaches" means the exported function's body calls an approved helper, or calls
 * another function in the same file that does. Sources are not executed; this is a
 * cheap tripwire that stops a new action from shipping with no gate at all. Whether
 * the gate is the *right* one is covered by the behavioural tenant-isolation suites.
 *
 * Scope: the three modules that held the findings this guard was added for. Widen
 * SCOPED_MODULES as other modules are audited; do not allowlist an action to make
 * this pass; add the missing gate instead.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(__dirname, "..");

const SCOPED_MODULES = [
  "app/[orgSlug]/[workspaceSlug]/discovery/actions.ts",
  "app/[orgSlug]/[workspaceSlug]/settings/actions.ts",
  "app/[orgSlug]/settings/actions.ts",
];

/** Helpers that resolve the caller AND scope to a workspace/org the caller belongs to. */
const AUTHZ_HELPERS = [
  "requireProductEntity",
  "requireProductWorkspace",
  "requireProductWorkspaceBySlug",
  "resolveWorkspace",
  "resolveWorkspaceAdmin",
  "resolveOrgAdmin",
  "requireWorkspaceContextOrThrow",
];

/**
 * Exports that act only on the caller's own identity (no tenant record id), listed
 * with the reason so a reviewer can challenge each one.
 */
const OWN_IDENTITY_ONLY: Record<string, string> = {
  "app/[orgSlug]/[workspaceSlug]/settings/actions.ts#createApiKey": "creates a key for the session user; ties to no tenant record",
  "app/[orgSlug]/[workspaceSlug]/settings/actions.ts#revokeApiKey": "revokes only a key owned by the session user (userId filter)",
};

type Fn = { name: string; exported: boolean; text: string };

function collectFunctions(file: string): Fn[] {
  const source = ts.createSourceFile(file, readFileSync(path.join(ROOT, file), "utf8"), ts.ScriptTarget.Latest, true);
  const fns: Fn[] = [];
  for (const node of source.statements) {
    const exported = !!ts.getModifiers(node as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      fns.push({ name: node.name.text, exported, text: node.body.getText(source) });
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        const init = decl.initializer;
        if (ts.isIdentifier(decl.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          fns.push({ name: decl.name.text, exported, text: init.body.getText(source) });
        }
      }
    }
  }
  return fns;
}

function callsIdentifier(text: string, name: string) {
  return new RegExp(`\\b${name}\\s*\\(`).test(text);
}

function authorizedFunctions(fns: Fn[]): Set<string> {
  const ok = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of fns) {
      if (ok.has(fn.name)) continue;
      const direct = AUTHZ_HELPERS.some((h) => callsIdentifier(fn.text, h));
      const viaLocal = [...ok].some((n) => callsIdentifier(fn.text, n));
      if (direct || viaLocal) {
        ok.add(fn.name);
        changed = true;
      }
    }
  }
  return ok;
}

describe("server actions reach an authorization helper", () => {
  it.each(SCOPED_MODULES)("%s", (file) => {
    expect(readFileSync(path.join(ROOT, file), "utf8").trimStart().startsWith('"use server"')).toBe(true);
    const fns = collectFunctions(file);
    const ok = authorizedFunctions(fns);
    const missing = fns
      .filter((fn) => fn.exported && !ok.has(fn.name) && !(`${file}#${fn.name}` in OWN_IDENTITY_ONLY))
      .map((fn) => fn.name);
    expect(missing).toEqual([]);
  });

  it("the scanner flags an action that only checks the session", () => {
    const fns: Fn[] = [
      { name: "bad", exported: true, text: "{ const s = await auth(); if (!s) throw 1; await prisma.x.delete({}) }" },
      { name: "good", exported: true, text: "{ await requireProductEntity('solution', id); }" },
      { name: "viaLocal", exported: true, text: "{ return helper(id); }" },
      { name: "helper", exported: false, text: "{ await resolveOrgAdmin(slug); }" },
    ];
    const ok = authorizedFunctions(fns);
    expect([...ok].sort()).toEqual(["good", "helper", "viaLocal"]);
  });
});
