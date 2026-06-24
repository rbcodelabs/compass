import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { remark } from "remark";
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
