# Compass UI system

Compass uses Tailwind CSS 4 and Base UI-backed primitives. This document defines the product-level visual vocabulary built on that foundation. The system is intentionally repository-native: tokens live in `app/globals.css`, primitives live in `components/ui`, and the living reference is available at `/ui`.

## Principles

- Express intent with semantic roles. Prefer `bg-surface-panel` and `text-text-subtle` to literal palette utilities.
- Reuse an existing primitive before introducing a local control.
- Keep variants small and purposeful. A `className` may place a component in a layout, but should not redefine its anatomy.
- Default to compact, calm density suitable for a professional work-management product.
- Preserve Base UI semantics, keyboard behavior, focus management, and accessible naming.
- Keep domain colors explicit only when color communicates real data or domain meaning, such as chart series.

## Layer ownership

| Layer | Location | Responsibility |
|---|---|---|
| Tokens | `app/globals.css` | Color roles, type roles, radii, elevation, spacing, and control heights |
| Primitives | `components/ui` | Accessible controls and low-level variants |
| Product patterns | `components/patterns` | Repeated Compass compositions such as headers, toolbars, cards, boards, and empty states |
| Workflows | Feature component folders | Domain behavior and workflow-specific composition |

Product patterns are introduced in phase 2. Do not move domain models or data fetching into the pattern layer.

## Semantic token vocabulary

### Surfaces

- `surface-app`: application canvas
- `surface-navigation` and `surface-navigation-active`: persistent navigation chrome
- `surface-panel`: raised or bounded content region
- `surface-card`: entity and summary cards
- `surface-inset`: recessed groups, quiet footers, and empty-state regions
- `surface-overlay`: modal backdrops
- `surface-interactive` and `surface-interactive-hover`: neutral interactive emphasis

### Text

- `text-primary`: headings and primary content
- `text-secondary`: supporting body copy
- `text-subtle`: metadata, hints, and low-emphasis labels
- `text-disabled`: unavailable controls or content
- `text-inverse`: content on dark product surfaces

### Borders and focus

- `border-default`: ordinary separation
- `border-strong`: emphasized boundaries and dashed drop zones
- `border-interactive`: selected or branded boundaries
- `border-focus`: visible keyboard focus

Focus must remain visible. Shared interactive primitives already use `ring`; custom interactive compositions should use `focus-visible` with `border-focus` or the existing `ring` token.

### Status

Each status has a foreground and soft surface pair:

- `status-neutral`
- `status-info`
- `status-success`
- `status-warning`
- `status-danger`

Use status roles for meaning, not decoration. Never rely on color alone: pair the treatment with text, an icon, or both.

### Density and elevation

- Control heights: `--control-height-sm`, `--control-height-md`, and `--control-height-lg`
- Responsive page gutters: `--space-page-x` and `--space-page-y`
- Elevation: `--shadow-card` and `--shadow-panel`
- Radius scale: Tailwind `rounded-sm` through `rounded-xl`, derived from `--radius`

Existing primitives currently encode matching control heights directly. New product patterns should consume these conventions, and primitives can move to the custom properties when touched by later migrations.

## Workspace branding contract

Workspace branding may override:

- `--primary`
- `--primary-foreground`
- `--ring`
- `--font-sans`

Semantic tokens that represent branded interaction reference those variables, so branding continues to flow through buttons, links, focus rings, and interactive borders. Do not replace branded roles with fixed indigo values. `WorkspaceThemeStyle` intentionally injects overrides at `:root` so portaled controls inherit them.

## Registry access

The `/ui` route has no database or session dependency. It is available when any of these conditions is true:

- `NODE_ENV=development`
- `VERCEL_ENV=preview`
- `COMPASS_UI_REGISTRY=1`

It returns 404 in production by default and includes `noindex` metadata. The explicit flag is the supported production override.

When adding a primitive or semantic token, add a representative state to `/ui`. Include default, disabled, loading, invalid, or empty states when applicable and verify the constrained-width example when the change affects responsive behavior.

## Contribution checklist

- Use semantic roles for shared presentation meaning.
- Preserve workspace branding for branded interactions.
- Use or extend an existing primitive before creating a local equivalent.
- Give every interactive control an accessible name and visible focus.
- Check default, hover/focus, disabled, loading, invalid, empty, and narrow-width states as applicable.
- Update `/ui` when a reusable token, component, or variant changes.
- Document any raw palette exception that represents domain data rather than general UI.

## Raw-color guard

Run `pnpm ui:colors` before opening a pull request. The guard scans product code for literal Tailwind palette utilities and fails only when a change adds an occurrence beyond the reviewed baseline in `docs/design/raw-color-baseline.json`. This lets existing debt decline incrementally without allowing new drift.

Prefer semantic roles. A literal color is acceptable only when it encodes domain data, visualization series, or user-configured branding. Put `ui-color-allow` on the same source line and explain the exception in a nearby comment. Marketing, help prose, brand previews, Canvas visualization internals, and the registry's literal palette demonstration are excluded at the path level.

Do not refresh the baseline simply to make a pull request pass. Use `pnpm ui:colors:baseline` only after a deliberate repository-wide review; a baseline update should normally reduce or preserve the total debt.

## Verification

- `pnpm lint` checks source quality.
- `pnpm test` runs the unit and integration suite.
- `pnpm ui:colors` rejects new literal palette usage in product UI.
- `pnpm test:e2e:functional` exercises authenticated workflows against a local seeded database.
- `DOCS_BASE_URL=<preview-url> pnpm test:e2e` captures the registry and critical workflow screenshots from an eligible preview deployment.

The CI workflow always runs lint, unit tests, and the color guard. It also captures and uploads the critical screenshots when the repository variable `COMPASS_SCREENSHOT_BASE_URL` points to a preview or staging deployment and `COMPASS_SCREENSHOT_SESSION_BASE64` contains a base64-encoded Playwright storage-state file for the curated workspace.
