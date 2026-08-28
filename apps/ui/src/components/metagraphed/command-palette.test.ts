import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./command-palette.tsx", import.meta.url)),
  "utf8",
);

describe("command palette loading boundary", () => {
  it("keeps the optional dialog body out of the shell until reader intent", () => {
    expect(source).toContain('import("./command-palette-body")');
    expect(source).toContain("export function preloadCommandPalette(): void");
    expect(source).toContain("void loadCommandPalette();");
  });

  it("renders an accessible acknowledgement instead of a blank first open", () => {
    expect(source).toContain('role="status"');
    expect(source).toContain('aria-label="Opening search"');
    expect(source).toContain("Opening search…");
    expect(source).toContain("fallback={<CommandPaletteOpening />}");
  });
});
