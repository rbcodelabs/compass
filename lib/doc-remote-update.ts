/** Who last wrote a doc, as the page knows it: the user behind `updatedById` (if any) and the write path (`Doc.source`). */
export type DocLastWriter = { name: string | null; source: string | null };

/** Words for "who changed this" in the live-update banner. Falls back to "someone" (a person) or "an agent" (any non-UI write). */
export function describeRemoteWriter(writer: DocLastWriter | null | undefined): string {
  const fromUi = !writer?.source || writer.source === "UI";
  if (writer?.name) return fromUi ? writer.name : `${writer.name} (via ${writer.source})`;
  return fromUi ? "someone" : "an agent";
}

/** True when the editor has focus and its user typed very recently: adopting remote content then would yank the text from under them. */
export function isTypingNow(focused: boolean, lastTypedAt: number, now: number, quietMs = 2_500): boolean {
  return focused && now - lastTypedAt < quietMs;
}
