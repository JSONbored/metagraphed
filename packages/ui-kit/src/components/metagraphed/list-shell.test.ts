import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./list-shell.tsx", import.meta.url)),
  "utf8",
);

describe("ListShell sticky table wrappers", () => {
  it("sticks the <thead> to the page scroll instead of a bounded internal viewport", () => {
    // The table's <thead> sticks against the *page* scroll (offset by the app
    // header + the filter bar's measured height), not an internal
    // overflow-bounded wrapper -- so there is no nested vertical scrollbar.
    // The wrapper only ever scrolls horizontally, on any viewport.
    expect(source).toContain('"mg-table-scroll overflow-x-auto"');
    expect(source).not.toContain("overflow-x-clip");
    expect(source).not.toContain("overflow-y-clip");
  });

  it("publishes the filter bar's measured height so the table header can offset below it", () => {
    // ResizeObserver-measured filter height, published as a CSS var on the
    // root wrapper -- the sticky offset math reads --mg-sticky-offset
    // (from AppShell) plus this to land the <thead> just below the filter bar.
    expect(source).toContain("--mg-list-filter-offset");
    expect(source).toContain('style={{ top: "var(--mg-sticky-offset, 3.5rem)" }}');
  });

  it("keeps the card wrapper's rounded-corner clipping the same for both modes", () => {
    expect(source).toContain(
      'const tableCard = "rounded border border-border bg-card overflow-hidden";',
    );
  });
});
