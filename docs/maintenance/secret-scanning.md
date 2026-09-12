# Secret scanning

Compass is a public repository. Any credential committed to it — on any branch,
in any commit, however briefly — must be treated as burned and rotated. Three
independent layers guard against that.

| Layer | Scope | Blocking? | Where |
| --- | --- | --- | --- |
| Local pre-commit hook | Staged changes | Yes, locally (bypassable) | `scripts/hooks/pre-commit` |
| CI secret scan | Full git history, all refs | Yes, on every PR | `.github/workflows/secret-scan.yml` |
| GitHub push protection | Provider-recognised tokens | Yes, at push time | Repository settings |

The CI job is the authoritative gate. The hook is a fast local convenience;
push protection is GitHub's own backstop for vendor token formats.

## Enabling the local hook

The hook is opt-in and adds no npm dependency. It needs the gitleaks binary:

```bash
brew install gitleaks   # or see https://github.com/gitleaks/gitleaks
pnpm hooks:install
```

`pnpm hooks:install` points `core.hooksPath` at `scripts/hooks`. Undo with
`pnpm hooks:uninstall`. If gitleaks is not installed the hook prints a warning
and lets the commit through rather than blocking you — CI still covers the PR.

To scan the full history yourself at any time:

```bash
pnpm scan:secrets
```

## When the scan fails

**If it is a real secret**, the commit is the least of the problem:

1. Remove the value from the code.
2. **Rotate the credential.** Assume it is compromised the moment it is
   committed — rotation is not optional even if it was never pushed.
3. Save the new value to 1Password *before* doing anything else with it, per
   the standing rule in `CLAUDE.md`.
4. If it was already pushed, the value is in history and amending will not
   remove it. Say so and get help rewriting history — do not quietly
   force-push over it.

**If it is a false positive**, apply the narrowest possible fix. In order of
preference:

1. A `gitleaks:allow` trailing comment on that one line.
2. A scoped entry in `.gitleaks.toml` that matches the exact value or the
   specific line shape.

Never disable a rule outright and never allowlist a whole directory. Doing
either blinds the scanner for all future code in that scope, which is how a
real secret eventually slips through.

## How `.gitleaks.toml` is structured

The config inherits the entire gitleaks default ruleset (`useDefault = true`)
and deliberately uses **no** `disabledRules`. Each known false positive is
allowlisted by its specific value or line shape, so the underlying rule stays
armed everywhere else:

- **`generic-api-key`** — test-fixture idempotency keys such as
  `idempotencyKey: "voice-hangup-0001"`. Scoped with `condition = "AND"` so it
  only applies to lines declaring an `idempotencyKey` inside `__tests__/` or
  `e2e/`. A real API key in a test file is still reported.
- **`private-key`** — the throwaway Ed25519 keypair in
  `e2e/functional/fixtures/native-policy-config.ts`, used only to sign policy
  fixtures in the functional suite. Allowlisted by its exact key material, not
  by path, so any *other* private key — including a different one added to that
  same file — is still reported.
- **`curl-auth-header`** — documentation placeholders matching
  `your_..._here`. A real token pasted into the docs is still reported.

When you change this config, verify both directions: that the intended false
positive goes quiet, **and** that a planted real secret in the same path is
still caught. A config that reports zero findings because it is blind is worse
than no config at all.

## Upgrading gitleaks

The CI pin lives in `GITLEAKS_VERSION` in `.github/workflows/secret-scan.yml`.
Bump it there and re-run `pnpm scan:secrets` locally with the matching version
to confirm the ruleset change does not introduce new findings.
