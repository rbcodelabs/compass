/**
 * Scale-to-fit for slide documents, ported from Commenter's `src/lib/slide-fit.ts`.
 *
 * Decks are almost always authored as a fixed canvas (1280x720, 1920x1080, a
 * 960x540 `.slide`), and rendered at natural size they sit jammed in the top
 * corner of a large viewport or spill off a small one. These two inline scripts
 * scale the slide's root element to fill the frame and centre it, letterboxed.
 *
 * They run inside the sandboxed preview iframe (see lib/artifact-preview-html.ts),
 * whose CSP allows inline scripts, and they are added at RENDER time
 * (lib/artifact-slides.ts) rather than stored, so every existing deck gets them.
 *
 * Differences from Commenter, deliberately:
 *  - No dock insets: Compass has no docked comment panel inside the frame.
 *  - No exit animation: Compass swaps the iframe from React rather than
 *    navigating the document, so there is no outgoing page to animate.
 *  - The entrance can only play once (Commenter's font deadline and
 *    `fonts.ready` could both fire it).
 *  - On settling, the fit dispatches {@link SLIDE_FIT_SETTLED_EVENT} so the
 *    preview handshake re-reports pin geometry against the final transform.
 *
 * Both scripts must stay plain ES5 with no backticks: they are interpolated into
 * template literals and run inside whatever the uploaded deck targets.
 */

/** Smallest canvas treated as a fixed slide; anything smaller is left alone. Mirrors Commenter's deck contract. */
export const MIN_CANVAS_WIDTH = 480
export const MIN_CANVAS_HEIGHT = 270
/** A root taller than this multiple of its width is a scrolling page, not a slide. */
export const MAX_CANVAS_ASPECT = 2

/**
 * Backstop for the hidden-until-fitted hold, in ms. A deck whose stylesheets
 * never resolve reveals here, unscaled — showing something beats showing nothing.
 */
const REVEAL_HARD_CAP_MS = 2500
/** Longest an already-fitted slide waits for webfonts before revealing, in ms. */
const FONT_SETTLE_TIMEOUT_MS = 400
/** Longest the fit waits for an out-of-process frame to become measurable (a size, and a box with area), in ms. Under the reveal backstop. */
const MEASURE_TIMEOUT_MS = 2000
const REVEAL_GLOBAL = "__compassSlideReveal"
const ENTER_MS = 260
const ENTER_RISE_PX = 18

/** Fired on `window` once the slide's transform has reached its final position. */
export const SLIDE_FIT_SETTLED_EVENT = "compass-slide-fit-settled"

/**
 * Hide-until-fitted, for injection BEFORE any of the deck's stylesheets.
 *
 * A pending render-blocking stylesheet blocks every script after it, so a fit
 * script at the end of body cannot run until the unscaled slide has already
 * been painted. An inline script ahead of the stylesheets runs at parse time,
 * before the first paint is possible. It also owns the backstop timer, so
 * nothing downstream can strand the viewer on a blank frame.
 */
export function slideFitPrelude(): string {
  return `<script>(function () {
  var docEl = document.documentElement;
  if (!docEl || !docEl.style) return;
  docEl.style.visibility = "hidden";
  var revealed = false;
  function reveal() {
    if (revealed) return false;
    revealed = true;
    docEl.style.visibility = "";
    return true;
  }
  window.${REVEAL_GLOBAL} = reveal;
  setTimeout(reveal, ${REVEAL_HARD_CAP_MS});
})();</script>`
}

/** The scale-to-fit script, for injection at the end of the slide's body. */
export function slideFitScript(): string {
  return `<script>(function () {
  var MIN_W = ${MIN_CANVAS_WIDTH};
  var MIN_H = ${MIN_CANVAS_HEIGHT};
  var MAX_ASPECT = ${MAX_CANVAS_ASPECT};
  var docEl = document.documentElement;
  var reveal = window.${REVEAL_GLOBAL} || function () {};

  function settled() {
    try { window.dispatchEvent(new Event("${SLIDE_FIT_SETTLED_EVENT}")); } catch (e) {}
  }
  /* Diagnostics: document.documentElement.dataset.compassFit is "fitted" or the bail reason. */
  function note(reason, detail) {
    try {
      docEl.setAttribute("data-compass-fit", reason);
      if (detail) docEl.setAttribute("data-compass-fit-detail", detail);
    } catch (e) {}
  }
  function bail(reason, detail) { note(reason, detail); reveal(); settled(); }

  if (!document.body) { bail("no-body"); return; }

  function viewportW() { return docEl.clientWidth; }
  function viewportH() { return docEl.clientHeight; }

  /* The slide canvas is the LARGEST box under body: injected chrome is small or fixed. */
  function pickSlideRoot() {
    var kids = document.body.children;
    var best = null;
    var bestArea = 0;
    var count = 0;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      var tag = el.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "LINK" || tag === "TEMPLATE" || tag === "NOSCRIPT") continue;
      if (el.hasAttribute && el.hasAttribute("data-compass-pick-highlight")) continue;
      count++;
      var area = el.offsetWidth * el.offsetHeight;
      if (area > bestArea) { bestArea = area; best = el; }
    }
    return { el: best, count: count };
  }

  /*
   * Wait until the frame can actually be measured. Chrome runs sandboxed
   * iframes out of process, and the frame can parse this far before its size
   * has arrived from the parent, or before its first real layout: the viewport
   * reads 0x0 and/or every box measures 0x0. Measuring then bails for good on a
   * perfectly fittable slide, at random, depending on which IPC wins. So retry
   * on resize and every animation frame until the viewport is non-zero and some
   * box has an area, and only give up (with a diagnostic) at the deadline.
   */
  var started = false;
  var picked = null;
  function measurable() {
    if (!viewportW() || !viewportH()) return false;
    picked = pickSlideRoot();
    return !!picked.el;
  }
  function tryStart() {
    if (started || !measurable()) return;
    started = true;
    window.removeEventListener("resize", tryStart);
    start();
  }
  tryStart();
  if (!started) {
    window.addEventListener("resize", tryStart);
    var poll = function () { if (!started) { tryStart(); if (!started) requestAnimationFrame(poll); } };
    requestAnimationFrame(poll);
    setTimeout(function () {
      if (started) return;
      started = true;
      window.removeEventListener("resize", tryStart);
      var vp = "viewport=" + viewportW() + "x" + viewportH();
      if (!viewportW() || !viewportH()) bail("zero-viewport", vp);
      else bail("no-root", vp + " candidates=" + (picked ? picked.count : 0));
    }, ${MEASURE_TIMEOUT_MS});
  }

  function start() {
  var root = picked.el;

  /* offsetWidth/Height ignore transforms, so re-fits never compound. */
  var naturalW = root.offsetWidth;
  var naturalH = root.offsetHeight;
  function geometry() {
    return "slide=" + naturalW + "x" + naturalH + " viewport=" + viewportW() + "x" + viewportH() +
      " candidates=" + picked.count + " tag=" + root.tagName;
  }

  /*
   * Does the root track the page width? Equal widths alone cannot say: a fixed
   * 960px canvas in a 960px-wide frame (or one whose scrollbar leaves exactly
   * 960px) measures the same as a width:100% page. So widen html and body for one
   * synchronous measurement and see whether the root follows. The document is
   * still hidden by the prelude and the styles are restored before this task
   * ends, so the probe width is never painted.
   */
  function tracksPageWidth() {
    var targets = [docEl, document.body];
    var saved = [];
    var probeW = viewportW() + 137;
    for (var i = 0; i < targets.length; i++) {
      var s = targets[i].style;
      saved.push([s.getPropertyValue("width"), s.getPropertyPriority("width")]);
      s.setProperty("width", probeW + "px", "important");
    }
    var probed = root.offsetWidth;
    for (var j = 0; j < targets.length; j++) {
      targets[j].style.setProperty("width", saved[j][0], saved[j][1]);
      if (!saved[j][0]) targets[j].style.removeProperty("width");
    }
    return Math.abs(probed - naturalW) > 1;
  }

  if (!naturalW || !naturalH) { bail("zero-box", geometry()); return; }
  /* Fluid: already 100% of the viewport, so it reflows on its own. Tested first so the recorded reason is the true one. */
  if (Math.abs(naturalW - viewportW()) <= 1 && tracksPageWidth()) { bail("fluid", geometry()); return; }
  if (naturalW < MIN_W || naturalH < MIN_H) { bail("below-min-canvas", geometry()); return; }
  if (naturalH > naturalW * MAX_ASPECT) { bail("too-tall", geometry()); return; }
  /* Overflow the author left visible is reachable content that fitting would clip; clipped or scrolling overflow is not. */
  if (window.getComputedStyle(root).overflowY === "visible" && root.scrollHeight > naturalH + 1) {
    bail("visible-overflow", geometry() + " scrollHeight=" + root.scrollHeight);
    return;
  }

  /* Out of flow, so an up-scaled box cannot widen the page. position:fixed stays a containing block for absolutely positioned children. */
  root.style.position = "fixed";
  root.style.left = "0";
  root.style.top = "0";
  root.style.margin = "0";
  root.style.transformOrigin = "top left";
  docEl.style.overflow = "hidden";
  document.body.style.overflow = "hidden";

  var animY = 0;
  /* The single writer of the root's transform. */
  function fit() {
    var scale = Math.min(viewportW() / naturalW, viewportH() / naturalH);
    var offsetX = (viewportW() - naturalW * scale) / 2;
    var offsetY = (viewportH() - naturalH * scale) / 2;
    root.style.transform = "translate(" + offsetX + "px, " + (offsetY + animY) + "px) scale(" + scale + ")";
    note("fitted", geometry() + " scale=" + scale);
  }

  var reduceMotion = false;
  try {
    reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch (e) {}

  function clearMotion() {
    root.style.transition = "";
    root.style.opacity = "";
  }

  fit();
  window.addEventListener("resize", fit);
  window.addEventListener("load", fit);

  var entered = false;
  function revealWithEntrance() {
    if (entered) return;
    entered = true;
    if (reduceMotion) { reveal(); settled(); return; }
    animY = ${ENTER_RISE_PX};
    root.style.opacity = "0";
    fit();
    if (reveal() === true) {
      /* Double rAF, so the posed style is painted before the transition attaches. */
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          root.style.transition = "transform ${ENTER_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1), opacity ${ENTER_MS}ms ease-out";
          animY = 0;
          root.style.opacity = "1";
          fit();
          setTimeout(function () { clearMotion(); settled(); }, ${ENTER_MS} + 60);
        });
      });
    } else {
      /* The backstop already revealed it; undo the pose in this same task, so it never paints. */
      animY = 0;
      clearMotion();
      fit();
      settled();
    }
  }

  /* Started only after the fit, so a slow font can only cost a brief blank on an already-correct slide. */
  var fontDeadline = setTimeout(revealWithEntrance, ${FONT_SETTLE_TIMEOUT_MS});
  var fonts = document.fonts;
  if (fonts && fonts.ready && typeof fonts.ready.then === "function") {
    fonts.ready.then(function () {
      clearTimeout(fontDeadline);
      if (!entered) fit();
      revealWithEntrance();
    });
  } else {
    clearTimeout(fontDeadline);
    revealWithEntrance();
  }
  }
})();</script>`
}

/**
 * Adds the prelude ahead of the slide document and the fit script at the end of
 * its body. The prelude goes first in the string rather than after `<head>`:
 * the preview prefixes its CSP meta ahead of the document anyway, and srcdoc
 * documents are never put in quirks mode by content before the doctype.
 */
export function withSlideFit(html: string): string {
  const script = slideFitScript()
  const closeBody = html.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i)
  const body = closeBody === -1 ? `${html}${script}` : `${html.slice(0, closeBody)}${script}${html.slice(closeBody)}`
  return `${slideFitPrelude()}${body}`
}
