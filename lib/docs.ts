import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import rehypeSlug from "rehype-slug";

const DOCS_DIR = path.join(process.cwd(), "docs/content");

export type DocMeta = {
  slug: string;
  title: string;
  description: string;
  icon: string;
  order: number;
  section: string;
};

export type DocPage = DocMeta & { html: string };

export type DocRaw = DocMeta & { content: string };

export type HelpSearchResult = {
  slug: string;
  title: string;
  section: string;
  heading: string | null;
  anchor: string | null;
  excerpt: string;
  score: number;
};

export function getAllDocs(): DocMeta[] {
  const files = fs
    .readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();
  return files
    .map((file) => {
      const slug = file.replace(/\.md$/, "");
      const raw = fs.readFileSync(path.join(DOCS_DIR, file), "utf-8");
      const { data } = matter(raw);
      return {
        slug,
        title: data.title as string,
        description: data.description as string,
        icon: data.icon as string,
        order: (data.order as number) ?? 0,
        section: (data.section as string) ?? "General",
      };
    })
    .sort((a, b) => a.order - b.order);
}

export async function getDoc(slug: string): Promise<DocPage | null> {
  const file = path.join(DOCS_DIR, `${slug}.md`);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf-8");
  const { data, content } = matter(raw);
  const result = await remark()
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeSlug)
    .use(rehypeStringify, { allowDangerousHtml: true })
    .process(content);
  return {
    slug,
    title: data.title as string,
    description: data.description as string,
    icon: data.icon as string,
    order: (data.order as number) ?? 0,
    section: (data.section as string) ?? "General",
    html: String(result),
  };
}

/**
 * Raw (unrendered) markdown body for a doc, plus its frontmatter metadata.
 * Cheaper than getDoc() when the caller wants plain text rather than HTML
 * (e.g. an MCP tool response consumed by an LLM).
 */
export function getDocRaw(slug: string): DocRaw | null {
  const file = path.join(DOCS_DIR, `${slug}.md`);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf-8");
  const { data, content } = matter(raw);
  return {
    slug,
    title: data.title as string,
    description: data.description as string,
    icon: data.icon as string,
    order: (data.order as number) ?? 0,
    section: (data.section as string) ?? "General",
    content: content.trim(),
  };
}

/**
 * Slugify heading text the same way rehype-slug (github-slugger under the
 * hood) does for plain-ASCII headings: lowercase, strip punctuation other
 * than spaces/hyphens, collapse whitespace to single hyphens. Covers every
 * heading currently in docs/content/ — cross-checked against getDoc()'s
 * actual rendered `id=` attributes in __tests__/help-search.test.ts so any
 * future drift (e.g. a heading with unusual punctuation) fails loudly.
 */
function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, "") // strip markdown emphasis/code markers
    .replace(/[^\w\- ]+/g, "") // strip remaining punctuation
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

type DocSection = {
  heading: string | null;
  anchor: string | null;
  text: string;
};

/** Split a doc's markdown body into ##/### heading-delimited sections. */
function splitIntoSections(body: string): DocSection[] {
  const sections: DocSection[] = [];
  let current: DocSection = { heading: null, anchor: null, text: "" };
  for (const line of body.split("\n")) {
    const match = /^(#{2,3})\s+(.*)$/.exec(line);
    if (match) {
      if (current.heading || current.text.trim()) sections.push(current);
      const heading = match[2].trim();
      current = { heading, anchor: slugifyHeading(heading), text: "" };
    } else {
      current.text += line + "\n";
    }
  }
  if (current.heading || current.text.trim()) sections.push(current);
  return sections;
}

function countMatches(haystack: string, needle: string): number {
  if (!needle) return 0;
  const lower = haystack.toLowerCase();
  return lower.split(needle).length - 1;
}

/** Short context window around the first query-term hit, or a leading snippet if none found. */
function buildExcerpt(text: string, terms: string[], contextChars = 100): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const lower = collapsed.toLowerCase();
  let idx = -1;
  for (const term of terms) {
    idx = lower.indexOf(term);
    if (idx !== -1) break;
  }
  if (idx === -1) {
    const snippet = collapsed.slice(0, contextChars * 2).trim();
    return snippet + (collapsed.length > contextChars * 2 ? "…" : "");
  }
  const start = Math.max(0, idx - contextChars);
  const end = Math.min(collapsed.length, idx + contextChars);
  return (start > 0 ? "…" : "") + collapsed.slice(start, end).trim() + (end < collapsed.length ? "…" : "");
}

/**
 * Full-text search over Compass's own product/usage documentation
 * (docs/content/*.md — the same corpus rendered at /help/[slug]). No
 * embeddings/vector search: term-overlap scoring weighted by field
 * (title > heading > description > body), returning the best-matching
 * section per doc so results can deep-link to a specific #anchor.
 */
export function searchHelp(query: string, limit = 5): HelpSearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const scoreText = (text: string) => terms.reduce((sum, term) => sum + countMatches(text, term), 0);

  const results: HelpSearchResult[] = [];

  for (const meta of getAllDocs()) {
    const file = path.join(DOCS_DIR, `${meta.slug}.md`);
    const raw = fs.readFileSync(file, "utf-8");
    const { content } = matter(raw);

    let best: HelpSearchResult | null = null;

    // Whole-doc match via title/description (points at the doc root, no anchor).
    const docScore = scoreText(meta.title) * 5 + scoreText(meta.description ?? "") * 3;
    if (docScore > 0) {
      best = {
        slug: meta.slug,
        title: meta.title,
        section: meta.section,
        heading: null,
        anchor: null,
        excerpt: meta.description || buildExcerpt(content, terms),
        score: docScore,
      };
    }

    // Per-section match via heading text + body.
    for (const sec of splitIntoSections(content)) {
      const total = (sec.heading ? scoreText(sec.heading) * 4 : 0) + scoreText(sec.text);
      if (total <= 0) continue;
      if (best && best.score >= total) continue;
      best = {
        slug: meta.slug,
        title: meta.title,
        section: meta.section,
        heading: sec.heading,
        anchor: sec.anchor,
        excerpt: buildExcerpt(sec.text || sec.heading || "", terms),
        score: total,
      };
    }

    if (best) results.push(best);
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Resolve a free-text topic to the single best-matching doc, for get_help.
 * Tries, in order: exact slug, slug without its numeric prefix, exact title,
 * then falls back to the same term-overlap scoring as searchHelp restricted
 * to title/description.
 */
export function getHelpTopic(topic: string): DocMeta | null {
  const q = topic.trim().toLowerCase();
  if (!q) return null;

  const all = getAllDocs();

  const bySlug = all.find((d) => d.slug.toLowerCase() === q || d.slug.replace(/^\d+-/, "").toLowerCase() === q);
  if (bySlug) return bySlug;

  const byTitle = all.find((d) => d.title.toLowerCase() === q);
  if (byTitle) return byTitle;

  const terms = q.split(/\s+/).filter(Boolean);
  const scored = all
    .map((d) => ({
      doc: d,
      score:
        (d.title.toLowerCase().includes(q) ? 3 : 0) +
        (d.description?.toLowerCase().includes(q) ? 1 : 0) +
        terms.reduce((sum, term) => sum + (d.title.toLowerCase().includes(term) ? 1 : 0), 0),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.doc ?? null;
}
