import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./list-shell.tsx", import.meta.url)),
  "utf8",
);

describe("ListShell sticky table wrappers", () => {
  it("keeps stickyHeader tables out of overflow scroll containers", () => {
    expect(source).toContain("const tableCard = stickyHeader");
    expect(source).toContain(
      '? "rounded border border-border bg-card overflow-x-clip"',
    );
    expect(source).toContain(
      'const tableScroll = stickyHeader ? "overflow-x-clip" : "overflow-x-auto";',
    );
    expect(source).not.toContain('stickyHeader ? "overflow-x-auto');
    expect(source).not.toContain("overflow-y-clip");
  });
});
