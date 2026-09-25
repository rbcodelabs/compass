/**
 * Every DndContext must receive a stable `id`.
 *
 * Without one, @dnd-kit derives its accessibility ids
 * (`aria-describedby="DndDescribedBy-N"`) from a module-level counter. The
 * long-lived server process keeps incrementing that counter across requests
 * while each browser starts from 0, so server HTML and client render disagree
 * and React logs a hydration mismatch on every board page after the first
 * request. Passing React's `useId()` makes the id identical on both sides.
 */
// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { useId } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DndContext, useDraggable } from "@dnd-kit/core";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [full] : [];
  });
}

/** The opening tag's props: from `<DndContext` up to its first child element. */
function openingTags(source: string): string[] {
  const tags: string[] = [];
  for (let index = source.indexOf("<DndContext"); index !== -1; index = source.indexOf("<DndContext", index + 1)) {
    const rest = source.slice(index + "<DndContext".length);
    const firstChild = rest.search(/\n\s*<[A-Za-z{]/);
    tags.push(firstChild === -1 ? rest : rest.slice(0, firstChild));
  }
  return tags;
}

function Handle() {
  const { attributes, setNodeRef } = useDraggable({ id: "card" });
  return <button ref={setNodeRef} {...attributes}>card</button>;
}

function Board({ stableId }: { stableId: boolean }) {
  const id = useId();
  return <DndContext id={stableId ? id : undefined}><Handle /></DndContext>;
}

const describedBy = (html: string) => html.match(/aria-describedby="([^"]+)"/)?.[1];

describe("DndContext ids", () => {
  it("without an id, repeated server renders drift (the hydration mismatch)", () => {
    const first = describedBy(renderToString(<Board stableId={false} />));
    const second = describedBy(renderToString(<Board stableId={false} />));
    expect(first).not.toEqual(second);
  });

  it("with useId, repeated server renders produce the same id", () => {
    const first = describedBy(renderToString(<Board stableId />));
    const second = describedBy(renderToString(<Board stableId />));
    expect(first).toBeDefined();
    expect(first).toEqual(second);
  });

  it("every DndContext in the app passes an id", () => {
    const root = path.resolve(__dirname, "..");
    const missing = [...sourceFiles(path.join(root, "components")), ...sourceFiles(path.join(root, "app"))]
      .flatMap((file) => openingTags(readFileSync(file, "utf8"))
        .filter((tag) => !/\bid=\{/.test(tag))
        .map(() => path.relative(root, file)));
    expect(missing).toEqual([]);
  });
});
