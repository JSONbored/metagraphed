// Plain JS (not .ts): imported both by the Playwright test (via its
// TS-aware runner) and by generate-overflow-baseline.mjs (run with plain
// `node`, no TypeScript loader) -- keeping one shared implementation instead
// of two copies that could drift.
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
    if (isContainedByScroll(el)) continue;
    if (hasViolatingAncestor(el)) continue;
    out.push({ tag: el.tagName, cls: typeof el.className === "string" ? el.className : "" });
  }
  return out;
}
