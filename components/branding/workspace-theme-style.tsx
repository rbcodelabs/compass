import type { ResolvedBranding } from "@/lib/branding";

interface Props {
  branding: ResolvedBranding | null;
}

/**
 * Injects a workspace's branding overrides as `:root` CSS variables.
 *
 * IMPORTANT: this must stay scoped to `:root`, not a wrapper div. Radix/
 * base-ui components (dropdowns, dialogs, the workspace switcher menu,
 * toasts) render via portals into `document.body`, outside any wrapper div
 * in the component tree — a div-scoped override would silently fail to
 * theme portaled UI. Every page under one workspace's routes belongs to
 * exactly one workspace, so global `:root` scoping is safe here (no
 * cross-workspace leakage within a single request/response).
 */
export function WorkspaceThemeStyle({ branding }: Props) {
  if (!branding) return null;

  const declarations: string[] = [];
  if (branding.primaryHex && branding.primaryForegroundHex) {
    declarations.push(`--primary:${branding.primaryHex};`);
    declarations.push(`--primary-foreground:${branding.primaryForegroundHex};`);
    declarations.push(`--ring:${branding.primaryHex};`);
  }
  if (branding.fontCssValue) {
    declarations.push(`--font-sans:${branding.fontCssValue};`);
  }

  // Only a logo was set — nothing to override at the CSS-variable level.
  if (declarations.length === 0) return null;

  const css = `:root{${declarations.join("")}}`;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: css }} />
      {branding.customFontLink && (
        <>
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="stylesheet" href={branding.customFontLink.href} />
        </>
      )}
    </>
  );
}
