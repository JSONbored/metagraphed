import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./list-shell.tsx", import.meta.url)),
  "utf8",
);

describe("ListShell sticky table wrappers", () => {
  it("gives stickyHeader tables their own bounded, internally-scrolling viewport", () => {
    // overflow-x-auto (or hidden/scroll) on the sticky <thead>'s ancestor
    // makes that ancestor the header's nearest scroll-container, and since
    // it never scrolls internally on its own (the page scrolls past it
    // instead), the header's "stuck" trigger never fires (#5073). Bounding
    // the height and scrolling both axes inside the wrapper makes it the
    // header's own scroll reference, so sticky and horizontal scroll both
    // work at once.
    // Substring checks, not a full-line match: this ternary reflows under
    // Prettier depending on line length, so an exact-line assertion breaks
    // every time the surrounding code shifts it past the print width.
    expect(source).toContain("const tableScroll = stickyHeader");
    expect(source).toContain('"mg-table-scroll overflow-auto"');
    expect(source).toContain(': "overflow-x-auto"');
    expect(source).not.toContain("overflow-x-clip");
    expect(source).not.toContain("overflow-y-clip");
  });

  it("keeps the card wrapper's rounded-corner clipping the same for both modes", () => {
    expect(source).toContain(
      'const tableCard = "rounded border border-border bg-card overflow-hidden";',
    );
  });
});
