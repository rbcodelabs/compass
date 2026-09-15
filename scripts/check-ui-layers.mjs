/**
 * Stacking-layer guard.
 *
 * Portalled overlays mount to <body>, so an overlay's z-index is compared
 * against every other overlay in the document — not against the element that
 * opened it. A popup whose positioner sits below a raised surface still
 * renders and is still keyboard-reachable, but it paints underneath and
 * refuses mouse clicks. That failure is invisible in isolation and invisible
 * in unit tests, and it has now shipped three times (Select, Combobox, and
 * the Dialog/DropdownMenu/Tooltip family).
 *
 * This guard pins the ladder documented in app/globals.css. Change both
 * together.
 *
 * Scope note: only Tailwind `z-*` classes are checked. Inline `zIndex` style
 * values (e.g. drag items in components/roadmap/native-timeline) are scoped to
 * a local stacking context, not to the global overlay ladder, so they are
 * deliberately out of scope.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();

/** The ladder. Values at or above OVERLAY_FLOOR are the shared overlay band. */
const OVERLAY_FLOOR = 50;
const LAYERS = {
  50: "surface (sheet backdrop + sheet content)",
  60: "panel (entity detail side panels)",
  70: "dialog (dialog + alert dialog, backdrop and content)",
  80: "popup (select, combobox, dropdown menu, tooltip positioners)",
};

/**
 * Which files are allowed to place an element on each raised layer. A new
 * raised surface must be registered here, which is the point: it forces
 * whoever adds one to look at the ladder and at everything already above it.
 */
const LAYER_OWNERS = {
  60: ["components/panels/panel-shell.tsx"],
  70: ["components/ui/dialog.tsx", "components/ui/alert-dialog.tsx"],
  80: [
    "components/ui/select.tsx",
    "components/ui/combobox.tsx",
    "components/ui/dropdown-menu.tsx",
    "components/ui/tooltip.tsx",
  ],
};

const POPUP_LAYER = 80;

/** Strip comments so prose that mentions a layer is not read as code. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

async function filesUnder(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(relative);
    return entry.name.endsWith(".tsx") ? [relative] : [];
  }));
  return files.flat();
}

const files = [...await filesUnder("app"), ...await filesUnder("components")];
const findings = [];

for (const file of files) {
  const raw = await readFile(path.join(root, file), "utf8");
  const source = stripComments(raw);

  // ── Rule 1: every z-index in the overlay band must be a rung on the ladder,
  // and only a registered owner may place an element on a raised layer.
  const zPattern = /(?<![\w-])z-(?:\[(\d+)\]|(\d+))(?![\w-])/g;
  for (const match of source.matchAll(zPattern)) {
    const value = Number(match[1] ?? match[2]);
    if (value < OVERLAY_FLOOR) continue; // in-flow app chrome, free-form
    const line = source.slice(0, match.index).split("\n").length;

    if (!(value in LAYERS)) {
      findings.push(
        `${file}:${line} z-${value} is not a rung on the stacking ladder; ` +
        `use one of ${Object.keys(LAYERS).join(", ")} (see app/globals.css)`
      );
      continue;
    }
    const owners = LAYER_OWNERS[value];
    if (owners && !owners.includes(file)) {
      findings.push(
        `${file}:${line} places an element on the ${LAYERS[value]} layer (z-${value}), ` +
        `which is owned by ${owners.join(", ")}. Reuse that primitive, or register ` +
        `this file in LAYER_OWNERS after checking what already sits above it.`
      );
    }
  }

  if (!file.startsWith("components/ui/")) continue;

  // ── Rule 2: a portal positioner is the portal's fixed-position root, so it
  // is the element whose z-index decides the whole popup's painting order. It
  // must be on the popup layer — above every surface it can be opened from.
  const positionerPattern = /<[\w.]*Positioner\b[^>]*>/g;
  for (const match of source.matchAll(positionerPattern)) {
    const line = source.slice(0, match.index).split("\n").length;
    const className = /className=(?:"([^"]*)"|\{cn\(\s*"([^"]*)")/.exec(match[0]);
    const classes = className ? (className[1] ?? className[2]) : "";
    if (!new RegExp(`(?<![\\w-])z-\\[${POPUP_LAYER}\\](?![\\w-])`).test(classes)) {
      findings.push(
        `${file}:${line} portal Positioner must sit on the popup layer ` +
        `(z-[${POPUP_LAYER}]); found ${classes ? `"${classes}"` : "no className"}. ` +
        `A lower value paints this popup underneath the panel (60) and dialog (70) ` +
        `layers, where it swallows mouse clicks but still responds to the keyboard.`
      );
    }
  }
}

if (findings.length) {
  console.error("Stacking-layer violations found:");
  findings.forEach((finding) => console.error(`  ${finding}`));
  process.exit(1);
}

console.log("UI stacking-layer guard passed. Overlay z-indexes follow the ladder in app/globals.css.");
