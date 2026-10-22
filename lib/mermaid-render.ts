/**
 * mermaid-render — client-side Mermaid -> sanitized SVG, shared by the Docs
 * editor node view and the read-only markdown view.
 *
 * Renderer: Pele (MIT, zero runtime dependencies, SVG themed through CSS
 * variables). It is imported dynamically from `pele/lazy`, so no diagram code
 * ships until a document actually contains a ```mermaid block, and then only
 * the shared core plus the chunk for that diagram type is fetched.
 *
 * Pele already escapes diagram text and filters links/styles; sanitizeSvg is a
 * second, independent layer so the markup we hand to innerHTML never depends
 * on the renderer being bug-free. Needs a DOM (DOMParser) — call it from the
 * browser or a jsdom test only.
 */

export type MermaidResult =
  | { ok: true; svg: string }
  | { ok: false; error: string; line?: number };

const FORBIDDEN_ELEMENTS = new Set([
  "script",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "animate",
  "set",
  "use",
  "image",
]);

const SAFE_HREF = /^(?:#|https?:|mailto:|\/(?!\/)|\.{0,2}\/)/i;

function isSafeStyle(value: string): boolean {
  const lowered = value.toLowerCase();
  if (lowered.includes("expression(") || lowered.includes("@import") || lowered.includes("javascript:")) {
    return false;
  }
  // Only fragment references (markers, gradients) may use url().
  const urls = lowered.match(/url\(\s*([^)]*)\)/g) ?? [];
  return urls.every((u) => /url\(\s*['"]?#/.test(u));
}

/** Strip anything executable or externally-loading from an SVG string. */
export function sanitizeSvg(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg" || doc.getElementsByTagName("parsererror").length > 0) {
    return "";
  }
  const all = [root, ...Array.from(root.querySelectorAll("*"))];
  for (const el of all) {
    if (FORBIDDEN_ELEMENTS.has(el.localName.toLowerCase())) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
      } else if (name === "href" || name === "xlink:href") {
        if (!SAFE_HREF.test(attr.value.trim())) el.removeAttribute(attr.name);
      } else if (name === "style" && !isSafeStyle(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return new XMLSerializer().serializeToString(root);
}

/**
 * Render Mermaid source to a sanitized SVG. Never throws: syntax errors and
 * renderer-limit errors come back as `{ ok: false }` so the caller can show the
 * message next to the raw source.
 */
export async function renderMermaid(source: string, idPrefix = "mmd"): Promise<MermaidResult> {
  if (!source.trim()) return { ok: false, error: "Empty diagram." };
  try {
    const { renderAsync } = await import("pele/lazy");
    const { svg } = await renderAsync(source, { idPrefix });
    const clean = sanitizeSvg(svg);
    if (!clean) return { ok: false, error: "The renderer produced invalid SVG." };
    return { ok: true, svg: clean };
  } catch (err) {
    const line = typeof (err as { line?: unknown })?.line === "number" ? (err as { line: number }).line : undefined;
    return { ok: false, error: err instanceof Error ? err.message : String(err), line };
  }
}
