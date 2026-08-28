// Extracted rather than inlined into the spec: this ran in two callers until
// #11678 deleted `generate-overflow-baseline.ts` with the baseline itself, and
// it stays a module because the browser-side contract below (self-contained,
// serializable) is worth stating once in a file of its own rather than burying
// in a `page.evaluate` argument.
//
// Runs inside the browser via page.evaluate -- must be self-contained (no
// closures over outer-scope variables) so Playwright can serialize it.
//
// Why this exists instead of the obvious `document.documentElement.scrollWidth
// > innerWidth` check: this app sets `overflow-x: clip` globally on <html> and
// <body> (almost certainly a deliberate guard against an accidental page-level
// horizontal scrollbar). That means scrollWidth-based detection is neutered
// here -- confirmed by injecting a blatant 900px synthetic element directly
// into <body> and observing documentElement.scrollWidth stay unchanged. The
// root always clips before scrollWidth can register anything, so that
// technique would sit green in CI forever regardless of what regresses.
//
// Instead this walks the DOM for elements whose own layout box escapes the
// viewport's left/right edges, excludes ones legitimately contained by a real
// horizontal-scroll ancestor (overflow-x: auto/scroll -- reachable, not a
// bug), and reports only the outermost offender in each violating subtree
// (skips descendants once an ancestor already accounts for the same
// violation, so one root cause produces one entry, not a cascade of dozens).
export function findOverflowViolations(viewportWidth) {
  function violates(rect) {
    return rect.right > viewportWidth + 1 || rect.left < -1;
  }

  function isContainedByScroll(el) {
    let node = el.parentElement;
    while (node && node !== document.body) {
      const overflowX = getComputedStyle(node).overflowX;
      if (overflowX === "auto" || overflowX === "scroll") return true;
      node = node.parentElement;
    }
    return false;
  }

  // Rich editors keep inactive panels and text-input buffers mounted outside
  // the viewport. They have geometry, but they cannot paint: inactive
  // GraphiQL tools use opacity: 0 and CodeMirror positions its 1000px input
  // inside a zero-height overflow-hidden buffer. Treating either as visible
  // overflow makes adding a real editor route to the sweep impossible while
  // saying nothing about what a reader can actually see.
  //
  // Keep this deliberately narrower than a general overflow:hidden escape:
  // visibly clipped content is still a UX failure and must still be reported.
  function isNonRendering(el) {
    let node = el;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
        return true;
      }
      const rect = node.getBoundingClientRect();
      const clipsX = style.overflowX === "hidden" || style.overflowX === "clip";
      const clipsY = style.overflowY === "hidden" || style.overflowY === "clip";
      if ((rect.width === 0 && clipsX) || (rect.height === 0 && clipsY)) return true;
      node = node.parentElement;
    }
    return false;
  }

  // CodeMirror deliberately makes its own scroll surface 50px wider than its
  // viewport and clips that implementation gutter at the editor boundary. It
  // remains a real, user-scrollable container; only the surplus scrollbar
  // gutter is hidden. This is distinct from an ordinary overflowing child:
  // require both an actually scrollable element and an in-viewport clipping
  // ancestor before excluding it.
  function isScrollableSurfaceClippedInFrame(el) {
    const ownOverflowX = getComputedStyle(el).overflowX;
    if (ownOverflowX !== "auto" && ownOverflowX !== "scroll") return false;
    let node = el.parentElement;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      const clips = style.overflowX === "hidden" || style.overflowX === "clip";
      if (clips && !violates(node.getBoundingClientRect())) return true;
      node = node.parentElement;
    }
    return false;
  }

  // Deliberately stops before <body>: body/html's own overflow-x: clip is
  // the global guard being worked around above, not a per-component
  // containment decision -- treating it as "handled" here would hide
  // exactly the bugs this check exists to catch.
  function hasViolatingAncestor(el) {
    let node = el.parentElement;
    while (node && node !== document.body) {
      if (violates(node.getBoundingClientRect())) return true;
      node = node.parentElement;
    }
    return false;
  }

  const out = [];
  for (const el of document.querySelectorAll("body *")) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (!violates(rect)) continue;
    if (isNonRendering(el)) continue;
    if (isScrollableSurfaceClippedInFrame(el)) continue;
    if (isContainedByScroll(el)) continue;
    if (hasViolatingAncestor(el)) continue;
    out.push({ tag: el.tagName, cls: typeof el.className === "string" ? el.className : "" });
  }
  return out;
}
