import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./list-shell.tsx", import.meta.url)),
  "utf8",
);

describe("ListShell sticky table wrappers", () => {
  it("bounds the table wrapper so a `sticky top-0` <thead> has something to pin against", () => {
    // This assertion is the inverse of the one it replaces, which required
    // the <thead> to stick against the PAGE with "no nested vertical
    // scrollbar". That arrangement is unreachable: `overflow-x: auto` makes
    // the wrapper a scroll container on BOTH axes (CSS Overflow 3 §3 coerces
    // a `visible` axis to `auto` when the other axis isn't `visible`), so it
    // is always the header's containing block. Unbounded, it never scrolls,
    // and `sticky top-0` silently resolved to a no-op on every table in this
    // shell -- verified in a browser on /chain/blocks: computed
    // `overflow: auto/auto` with scrollHeight === clientHeight.
    expect(source).toContain('"mg-table-scroll overflow-x-auto"');
    // The cap is a token, not a literal -- /validators builds its own shell
    // and has to agree with this one.
    expect(source).toContain(
      '"max-h-[var(--mg-list-viewport-max,70vh)] overflow-y-auto"',
    );
    expect(source).not.toContain("overflow-x-clip");
    expect(source).not.toContain("overflow-y-clip");
  });

  it("no longer publishes a filter-height offset for the header to read", () => {
    // --mg-list-filter-offset existed so a page-sticky <thead> could clear
    // the filter bar. Nothing ever read it (it was published, never
    // consumed), and a header pinned to its own scrollport has no use for
    // it -- the correct offset there is 0, independent of page chrome.
    expect(source).not.toContain("--mg-list-filter-offset");
    expect(source).not.toContain("ResizeObserver");
  });

  it("stacks the filter bar below the page's sticky tab strip, not on top of it", () => {
    // #8254: the bar pinned to bare --mg-sticky-offset, which is where the hub
    // tab strip also pins -- on /chain the two overlapped on every scroll. The
    // 0px fallback keeps pages without a strip unaffected.
    expect(source).toContain(
      '"calc(var(--mg-sticky-offset, 3.5rem) + var(--mg-tabs-h, 0px))"',
    );
  });

  it("keeps the card wrapper's rounded-corner clipping the same for both modes", () => {
    expect(source).toContain(
      'const tableCard = "rounded border border-border bg-card overflow-hidden";',
    );
  });
});
