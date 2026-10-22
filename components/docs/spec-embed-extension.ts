/**
 * SpecEmbed: a TipTap block node for a Compass record embedded in a Doc.
 *
 * Markdown form (see lib/doc-embeds): a paragraph consisting of exactly one
 * `[title](compass://kind/uuid)` link. Everything else, including the same
 * link inside prose, a list or a quote, is left to the ordinary Link mark, and
 * the reserved `compass-embed` code fence is left to the ordinary code block.
 *
 * Additive by construction: the markdown-it rule below only rewrites a
 * top-level paragraph that passes lib/doc-embeds' own whole-paragraph test, so
 * a document without such a paragraph parses and serializes exactly as before.
 * The node serializes to the same single line it was parsed from.
 *
 * Phase 1 renders the node as a plain, non-interactive block; the live card is
 * a later phase.
 */
import { Node } from "@tiptap/react";
import { isDocEmbedKind, parseBlockEmbedLine, serializeEmbed } from "@/lib/doc-embeds";

/** The subset of markdown-it this rule touches (markdown-it is not a direct dependency). */
type MdToken = {
  type: string;
  level: number;
  content: string;
  attrGet(name: string): string | null;
  children: MdToken[] | null;
  block: boolean;
  meta: unknown;
};
type MdState = { tokens: MdToken[]; Token: new (type: string, tag: string, nesting: number) => MdToken };
type MarkdownIt = {
  core: { ruler: { push(name: string, fn: (state: MdState) => void): void } };
  renderer: { rules: Record<string, ((tokens: MdToken[], idx: number) => string) | undefined> };
  utils: { escapeHtml(s: string): string };
};

const TOKEN_TYPE = "spec_embed";
const HTML_ATTR = "data-compass-embed";

/**
 * tiptap-markdown calls parse.setup before EVERY render; the markdown-it
 * instance is long-lived, so guard against stacking a new rule each time.
 */
const installed = new WeakSet<object>();

function isSingleCompassLink(inline: MdToken): boolean {
  const children = inline.children ?? [];
  if (children.length < 2) return false;
  const first = children[0];
  const last = children[children.length - 1];
  if (first.type !== "link_open" || last.type !== "link_close") return false;
  if (!first.attrGet("href")?.startsWith("compass://")) return false;
  // Exactly one link: no sibling link tokens.
  return children.filter((t) => t.type === "link_open").length === 1;
}

function installRule(md: MarkdownIt) {
  if (installed.has(md)) return;
  installed.add(md);

  md.core.ruler.push(TOKEN_TYPE, (state) => {
    const out: MdToken[] = [];
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const [open, inline, close] = [tokens[i], tokens[i + 1], tokens[i + 2]];
      if (
        open.type === "paragraph_open" &&
        open.level === 0 &&
        inline?.type === "inline" &&
        close?.type === "paragraph_close" &&
        isSingleCompassLink(inline)
      ) {
        // `inline.content` is the paragraph's raw source, so the title is read
        // with the same escaping rules lib/doc-embeds serializes with.
        const embed = parseBlockEmbedLine(inline.content);
        if (embed) {
          const token = new state.Token(TOKEN_TYPE, "", 0);
          token.block = true;
          token.meta = embed;
          out.push(token);
          i += 2;
          continue;
        }
      }
      out.push(open);
    }
    state.tokens = out;
  });

  md.renderer.rules[TOKEN_TYPE] = (tokens, idx) => {
    const { kind, id, title } = tokens[idx].meta as { kind: string; id: string; title: string };
    const esc = md.utils.escapeHtml;
    return `<div ${HTML_ATTR} data-kind="${esc(kind)}" data-id="${esc(id)}" data-title="${esc(title)}"></div>\n`;
  };
}

export const SpecEmbed = Node.create({
  name: "specEmbed",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      kind: { default: null },
      id: { default: null },
      title: { default: "" },
    };
  },

  parseHTML() {
    return [
      {
        tag: `div[${HTML_ATTR}]`,
        getAttrs: (el) => {
          const dom = el as HTMLElement;
          const kind = dom.getAttribute("data-kind");
          const id = dom.getAttribute("data-id");
          if (!isDocEmbedKind(kind) || !id) return false;
          return { kind, id, title: dom.getAttribute("data-title") ?? "" };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const { kind, id, title } = node.attrs as { kind: string; id: string; title: string };
    return [
      "div",
      { [HTML_ATTR]: "", "data-kind": kind, "data-id": id, "data-title": title, class: "spec-embed" },
      title || `${kind} ${id}`,
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(
          state: { write(s: string): void; closeBlock(n: unknown): void },
          node: { attrs: { kind: never; id: string; title: string } }
        ) {
          state.write(serializeEmbed({ kind: node.attrs.kind, id: node.attrs.id, title: node.attrs.title ?? "" }));
          state.closeBlock(node);
        },
        parse: {
          setup(markdownit: MarkdownIt) {
            installRule(markdownit);
          },
        },
      },
    };
  },
});
